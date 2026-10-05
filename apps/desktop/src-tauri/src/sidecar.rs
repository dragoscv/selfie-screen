use std::sync::Mutex;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Line the sidecar prints on stdout once it is listening.
const READY_PREFIX: &str = "TIKSEE_SIDECAR_READY ";

#[derive(Debug, Clone, Default, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub version: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct SidecarState {
    pub status: Mutex<SidecarStatus>,
    child: Mutex<Option<CommandChild>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl SidecarState {
    /// Spawn the Node service and pump its output until it exits.
    ///
    /// The renderer never talks to the sidecar through Tauri IPC; it connects
    /// directly to the loopback WebSocket whose port we learn from the ready
    /// line. Tauri's only job is lifecycle: start it, surface its logs, and
    /// guarantee it dies with the app.
    pub fn spawn(&self, app: &AppHandle) -> Result<(), String> {
        self.kill();

        let script = resolve_script(app)?;
        log::info!("[sidecar] launching {}", script.display());

        let (mut rx, child) = app
            .shell()
            .command("node")
            .args([script.to_string_lossy().to_string()])
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

        *self.child.lock().unwrap() = Some(child);
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
                        let line = String::from_utf8_lossy(&bytes).to_string();
                        for line in line.lines() {
                            handle_line(&handle, line);
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).to_string();
                        log::warn!("[sidecar] {}", line.trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!("[sidecar] terminated: {:?}", payload.code);
                        if let Some(state) = handle.try_state::<SidecarState>() {
                            let mut status = state.status.lock().unwrap();
                            status.running = false;
                            status.error = Some(format!(
                                "Sidecar exited with code {}",
                                payload.code.unwrap_or(-1)
                            ));
                        }
                        let _ = handle.emit("sidecar://exited", payload.code);
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

/// Locate the bundled sidecar script.
///
/// In a packaged build it ships as a resource; in development it is the tsup
/// output in the sibling workspace, so the same code path works for both.
fn resolve_script(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(path) = app.path().resolve("sidecar/index.js", BaseDirectory::Resource)
        && path.exists()
    {
        return Ok(path);
    }

    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecar/dist/index.js")
        .canonicalize()
        .map_err(|e| format!("sidecar bundle not found: {e}"))?;

    // On Windows `canonicalize` yields a `\\?\` extended-length path, which
    // Node's module resolver mis-parses ("EISDIR ... lstat 'E:'"). Strip it.
    let text = dev.to_string_lossy();
    let cleaned = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
    Ok(std::path::PathBuf::from(cleaned))
}
