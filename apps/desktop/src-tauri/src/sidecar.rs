use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};

use crate::secrets;

/// Line the sidecar prints on stdout once it is listening.
const READY_PREFIX: &str = "TIKSEE_SIDECAR_READY ";

/// Name of the bundled Node runtime (`bundle.externalBin`, minus the triple).
const SIDECAR_BIN: &str = "tiksee-sidecar";
/// Sidecar entry point inside the bundle's resource directory.
const BUNDLED_SCRIPT: &str = "sidecar/dist/index.js";

/// Crash-loop policy: 1 s, 2 s, 4 s … capped at 30 s; a run that stayed up
/// for a minute resets the counter; ten crashes in a row stop the loop.
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
const HEALTHY_AFTER: Duration = Duration::from_secs(60);
const MAX_RAPID_RESTARTS: u32 = 10;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub version: String,
    pub error: Option<String>,
    /// Automatic restarts since the last healthy minute or manual restart.
    pub restarts: u32,
}

#[derive(Default)]
struct Restarts {
    count: u32,
    started_at: Option<Instant>,
}

#[derive(Default)]
pub struct SidecarState {
    pub status: Mutex<SidecarStatus>,
    child: Mutex<Option<CommandChild>>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Bumped on every launch and kill. A termination or pending respawn
    /// whose generation is stale was caused by us and must not respawn.
    generation: AtomicU64,
    restarts: Mutex<Restarts>,
}

impl SidecarState {
    /// Start (or restart) the sidecar on request; resets the crash counter.
    ///
    /// The renderer never talks to the sidecar through Tauri IPC; it connects
    /// directly to the loopback WebSocket whose port we learn from the ready
    /// line. Tauri's only job is lifecycle: start it, surface its logs,
    /// restart it when it crashes, and guarantee it dies with the app.
    pub fn spawn(&self, app: &AppHandle) -> Result<(), String> {
        self.restarts.lock().unwrap().count = 0;
        self.status.lock().unwrap().restarts = 0;
        self.launch(app)
    }

    fn launch(&self, app: &AppHandle) -> Result<(), String> {
        self.kill();
        let generation = self.generation.load(Ordering::SeqCst);

        let (mut rx, child) = build_command(app)?
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

        *self.child.lock().unwrap() = Some(child);
        self.restarts.lock().unwrap().started_at = Some(Instant::now());
        {
            let mut status = self.status.lock().unwrap();
            status.running = true;
            status.error = None;
        }

        let handle = app.clone();
        let task = tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        for line in text.lines() {
                            handle_line(&handle, line);
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).to_string();
                        log::warn!("[sidecar] {}", line.trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        on_terminated(&handle, generation, payload.code);
                        break;
                    }
                    CommandEvent::Error(message) => {
                        log::error!("[sidecar] error: {message}");
                    }
                    _ => {}
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);

        Ok(())
    }

    /// Kill the child process. Called on window close and app exit — an
    /// orphaned sidecar would keep the serial port and the OBS port locked.
    pub fn kill(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        let mut status = self.status.lock().unwrap();
        status.running = false;
        status.port = 0;
    }
}

/// The child exited on its own: report it, then respawn with backoff.
fn on_terminated(app: &AppHandle, generation: u64, code: Option<i32>) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    if state.generation.load(Ordering::SeqCst) != generation {
        // We killed it (restart, quit); nothing to recover.
        return;
    }

    log::warn!("[sidecar] terminated: {code:?}");
    {
        let mut status = state.status.lock().unwrap();
        status.running = false;
        status.port = 0;
        status.error = Some(format!("Sidecar exited with code {}", code.unwrap_or(-1)));
    }
    let _ = app.emit("sidecar://exited", code);

    let attempt = {
        let mut restarts = state.restarts.lock().unwrap();
        if restarts
            .started_at
            .is_some_and(|started| started.elapsed() >= HEALTHY_AFTER)
        {
            restarts.count = 0;
        }
        restarts.count += 1;
        restarts.count
    };

    if attempt > MAX_RAPID_RESTARTS {
        let message = format!(
            "Sidecar crashed {MAX_RAPID_RESTARTS} times in a row; automatic restarts stopped"
        );
        log::error!("[sidecar] {message}");
        state.status.lock().unwrap().error = Some(message);
        return;
    }

    let delay = backoff(attempt);
    state.status.lock().unwrap().restarts = attempt;
    log::info!("[sidecar] restarting in {delay:?} (attempt {attempt}/{MAX_RAPID_RESTARTS})");
    let _ = app.emit(
        "sidecar://restarting",
        serde_json::json!({ "attempt": attempt, "delayMs": delay.as_millis() as u64 }),
    );

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let Some(state) = handle.try_state::<SidecarState>() else {
            return;
        };
        // A manual restart or quit during the wait supersedes this respawn.
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Err(error) = state.launch(&handle) {
            log::error!("[sidecar] respawn failed: {error}");
            state.status.lock().unwrap().error = Some(error);
        }
    });
}

fn backoff(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    (BACKOFF_START * 2u32.pow(exponent)).min(BACKOFF_CAP)
}

fn handle_line(app: &AppHandle, line: &str) {
    if let Some(payload) = line.strip_prefix(READY_PREFIX)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(payload)
    {
        let port = value.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
        let version = value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(state) = app.try_state::<SidecarState>() {
            let mut status = state.status.lock().unwrap();
            status.running = true;
            status.port = port;
            status.version = version.clone();
            status.error = None;
        }
        log::info!("[sidecar] ready on port {port} (v{version})");
        let _ = app.emit("sidecar://ready", serde_json::json!({ "port": port }));
        return;
    }
    if !line.trim().is_empty() {
        log::info!("[sidecar] {line}");
    }
}

/// Build the launch command.
///
/// Packaged builds run the bundled Node runtime (`externalBin`) on the
/// bundled script, so the installed app needs no system Node. Development
/// runs the system `node` on the workspace build output. A release binary
/// built without the staged bundle falls back to the development layout.
fn build_command(app: &AppHandle) -> Result<Command, String> {
    let shell = app.shell();
    let command = match bundled_script(app) {
        Some(script) => {
            log::info!(
                "[sidecar] launching bundled runtime with {}",
                script.display()
            );
            shell
                .sidecar(SIDECAR_BIN)
                .map_err(|e| format!("bundled sidecar runtime missing: {e}"))?
                .arg(script)
        }
        None => {
            if let Some(src) = dev_source() {
                // Hot reload: node restarts the sidecar on every save in
                // apps/sidecar/src or packages/*/src; the new "ready" line
                // re-emits sidecar://ready and the windows reconnect.
                log::info!("[sidecar] launching watch mode on {}", src.display());
                let sidecar_src = src.parent().unwrap_or(&src).to_path_buf();
                let sidecar_dir = sidecar_src.parent().unwrap_or(&sidecar_src).to_path_buf();
                let core_src = sidecar_dir.join("../../packages/core/src");
                // --watch-path limits restarts to source edits; the default
                // import-graph watch also fired on node_modules churn.
                shell
                    .command("node")
                    .arg(format!("--watch-path={}", sidecar_src.display()))
                    .arg(format!("--watch-path={}", core_src.display()))
                    .args([
                        "--watch-preserve-output",
                        "--conditions=source",
                        "--import",
                        "tsx",
                    ])
                    .arg(&src)
                    .current_dir(sidecar_dir)
            } else {
                let script = dev_script()?;
                log::info!("[sidecar] launching system node with {}", script.display());
                shell.command("node").arg(script)
            }
        }
    };
    Ok(command.envs(sidecar_env(app)))
}

/// `TIKSEE_SIDECAR_WATCH=1` (set by `pnpm dev:app`) runs the sidecar from source.
fn dev_source() -> Option<PathBuf> {
    if !cfg!(debug_assertions) || std::env::var("TIKSEE_SIDECAR_WATCH").ok().as_deref() != Some("1")
    {
        return None;
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecar/src/index.ts")
        .canonicalize()
        .ok()?;
    Some(strip_verbatim(&src))
}

fn bundled_script(app: &AppHandle) -> Option<PathBuf> {
    if tauri::is_dev() {
        return None;
    }
    let script = app
        .path()
        .resolve(BUNDLED_SCRIPT, BaseDirectory::Resource)
        .ok()
        .filter(|path| path.is_file())?;

    // build.rs drops a zero-byte placeholder runtime so `cargo check` works
    // on a fresh clone; never try to execute that.
    let runtime = std::env::current_exe()
        .ok()?
        .parent()?
        .join(format!("{SIDECAR_BIN}{}", std::env::consts::EXE_SUFFIX));
    let real = std::fs::metadata(&runtime).is_ok_and(|meta| meta.len() > 0);
    real.then(|| strip_verbatim(&script))
}

/// The tsdown output in the sibling workspace.
fn dev_script() -> Result<PathBuf, String> {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecar/dist/index.js")
        .canonicalize()
        .map_err(|e| format!("sidecar bundle not found: {e}"))?;
    Ok(strip_verbatim(&dev))
}

/// On Windows `canonicalize` yields a `\\?\` extended-length path, which
/// Node's module resolver mis-parses ("EISDIR ... lstat 'E:'"). Strip it.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

/// Environment for the child: data dir plus the credentials only native code
/// may read. Values are never logged — only whether they were provided.
fn sidecar_env(app: &AppHandle) -> Vec<(String, String)> {
    let mut env = Vec::new();
    match app.path().app_data_dir() {
        Ok(dir) => env.push((
            "TIKSEE_DATA_DIR".to_string(),
            strip_verbatim(&dir).to_string_lossy().to_string(),
        )),
        Err(error) => log::warn!("[sidecar] no app data dir: {error}"),
    }
    for (user, var) in [
        (secrets::CODAI_KEY, "TIKSEE_CODAI_KEY"),
        (secrets::VMUI_KEY, "TIKSEE_VMUI_KEY"),
    ] {
        match secrets::read(user) {
            Ok(Some(value)) if !value.trim().is_empty() => {
                log::info!("[sidecar] {var} provided");
                env.push((var.to_string(), value));
            }
            Ok(_) => {}
            Err(error) => log::warn!("[sidecar] could not read {user}: {error}"),
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_at_thirty_seconds() {
        let delays: Vec<u64> = (1..=10).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 30, 30, 30, 30, 30]);
    }

    #[test]
    fn verbatim_prefix_is_removed() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\E:\a\b.js")),
            PathBuf::from(r"E:\a\b.js")
        );
        assert_eq!(strip_verbatim(Path::new(r"E:\a")), PathBuf::from(r"E:\a"));
    }
}
