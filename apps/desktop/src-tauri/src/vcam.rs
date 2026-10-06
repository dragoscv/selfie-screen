//! TikSee Camera producer: publishes the studio's NV12 frames into the
//! `Global\TikSeeVcam` ring that `tiksee_vcam.dll` (loaded by the Windows
//! Camera Frame Server) serves to TikTok LIVE Studio and other apps.
//!
//! The unelevated app cannot create a `Global\` section, so it opens the one
//! the DLL creates when a consumer starts streaming, retrying at most every
//! 2 s. Until then frames are dropped and `vcam_status` reports "off".
//!
//! Transport: Tauri raw IPC measured ~200 ms per 3.1 MB frame (≈4 fps,
//! 2026-10-06), so frames arrive over a loopback binary WebSocket
//! (`vcam_endpoint` gives the port + a per-launch token). Each binary message
//! is `u32 LE width | u32 LE height | NV12 bytes`. `vcam_frame` stays as a
//! fallback.

use serde::Serialize;
use tauri::ipc::Request;

pub use imp::{VcamCtl, init};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcamStatus {
    /// "off" | "waiting" | "streaming" | "unregistered" | "error"
    pub state: &'static str,
    /// `(width, height, fps)` the consuming app negotiated.
    pub consumer: Option<(u32, u32, u32)>,
    /// Frames published per second (smoothed).
    pub fps: f32,
    pub registered: bool,
    pub error: Option<String>,
}

/// Raw NV12 frame in the body; `x-w` / `x-h` headers give its size.
#[tauri::command]
pub async fn vcam_frame(
    state: tauri::State<'_, VcamCtl>,
    request: Request<'_>,
) -> Result<(), String> {
    imp::frame(&state, &request)
}

#[tauri::command]
pub fn vcam_status(state: tauri::State<'_, VcamCtl>) -> VcamStatus {
    imp::status(&state)
}

/// Loopback WebSocket endpoint for frames: `ws://127.0.0.1:<port>/<token>`.
#[derive(Debug, Clone, Serialize)]
pub struct VcamEndpoint {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn vcam_endpoint(state: tauri::State<'_, VcamCtl>) -> Result<VcamEndpoint, String> {
    imp::endpoint(&state)
}

#[tauri::command]
pub fn vcam_configure(
    state: tauri::State<'_, VcamCtl>,
    portrait: bool,
    fps: u32,
) -> Result<(), String> {
    imp::configure(&state, portrait, fps)
}

/// "Repair camera": re-registers the source and the virtual camera (UAC).
#[tauri::command]
pub async fn vcam_register(app: tauri::AppHandle) -> Result<u32, String> {
    imp::register(app).await
}

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    use tauri::Manager;
    use tauri::ipc::{InvokeBody, Request};
    use tiksee_vcam_shared::layout::{SECTION_NAME, clsid_key};
    use tiksee_vcam_shared::win::{Section, tick_ms};
    use tiksee_vcam_shared::{FrameError, Orientation, OutputConfig, Ring};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
    use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::core::{HSTRING, PCWSTR, w};

    use super::VcamStatus;

    const RETRY_EVERY: Duration = Duration::from_secs(2);
    /// No frame for this long = the studio stopped feeding the camera.
    const IDLE_AFTER: Duration = Duration::from_secs(1);
    const SETUP_EXE: &str = "tiksee-vcam-setup.exe";
    /// Portrait 60 fps until the studio configures the camera (TikTok is vertical).
    const DEFAULT_OUTPUT: OutputConfig = OutputConfig {
        orientation: Orientation::Portrait,
        fps: 60,
    };

    /// The section handle and view are process-wide; the ring is atomics
    /// plus a seqlock with this process as the single writer.
    struct SendSection(Section);
    // SAFETY: see above.
    unsafe impl Send for SendSection {}

    #[derive(Default)]
    struct Inner {
        section: Option<SendSection>,
        last_attempt: Option<Instant>,
        /// Output to apply once the section is mapped.
        pending: Option<OutputConfig>,
        last_frame: Option<Instant>,
        fps: f32,
        error: Option<String>,
    }

    impl Inner {
        fn ring(&mut self) -> Option<Ring> {
            if self.section.is_none()
                && self
                    .last_attempt
                    .is_none_or(|at| at.elapsed() >= RETRY_EVERY)
            {
                self.last_attempt = Some(Instant::now());
                // Open first: an unelevated app lacks SeCreateGlobalPrivilege.
                let section = Section::open(SECTION_NAME).or_else(|_| {
                    Section::create(SECTION_NAME, self.pending.unwrap_or(DEFAULT_OUTPUT))
                });
                if let Ok(section) = section {
                    log::info!("vcam: ring mapped (created={})", section.created());
                    if let Some(config) = self.pending.take() {
                        section.ring().configure(config);
                    }
                    self.section = Some(SendSection(section));
                }
            }
            self.section.as_ref().map(|s| s.0.ring())
        }

        fn record_frame(&mut self) {
            let now = Instant::now();
            if let Some(last) = self.last_frame {
                let dt = now.duration_since(last).as_secs_f32();
                if dt > 0.0 && dt < IDLE_AFTER.as_secs_f32() {
                    let instant = 1.0 / dt;
                    self.fps = if self.fps == 0.0 {
                        instant
                    } else {
                        self.fps * 0.9 + instant * 0.1
                    };
                } else {
                    self.fps = 0.0;
                }
            }
            self.last_frame = Some(now);
        }
    }

    #[derive(Default)]
    pub struct VcamCtl {
        inner: std::sync::Arc<Mutex<Inner>>,
        endpoint: Mutex<Option<super::VcamEndpoint>>,
    }

    impl VcamCtl {
        fn lock(&self) -> MutexGuard<'_, Inner> {
            lock_inner(&self.inner)
        }

        fn publish(&self, width: u32, height: u32, frame: &[u8]) -> Result<(), String> {
            publish(&self.inner, width, height, frame)
        }
    }

    fn lock_inner(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
        inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn publish(shared: &Mutex<Inner>, width: u32, height: u32, frame: &[u8]) -> Result<(), String> {
        {
            let mut inner = lock_inner(shared);
            let Some(ring) = inner.ring() else {
                // No consumer has started the camera yet: nothing to feed.
                return Ok(());
            };
            let result = ring.publish_with(width, height, tick_ms(), |px| {
                if px.len() != frame.len() {
                    return Err(FrameError::WrongLength {
                        expected: px.len(),
                        actual: frame.len(),
                    });
                }
                px.copy_from_slice(frame);
                Ok(())
            });
            match result {
                Ok(_) => {
                    inner.error = None;
                    inner.record_frame();
                    Ok(())
                }
                Err(error) => {
                    let message = error.to_string();
                    inner.error = Some(message.clone());
                    Err(message)
                }
            }
        }
    }

    impl VcamCtl {
        fn status(&self) -> VcamStatus {
            let registered = registered();
            let mut inner = self.lock();
            let ring = inner.ring();
            let consumer = ring.and_then(|r| r.active());
            let feeding = inner.last_frame.is_some_and(|at| at.elapsed() < IDLE_AFTER);
            let fps = if feeding { inner.fps } else { 0.0 };
            let state = if !registered {
                "unregistered"
            } else if inner.error.is_some() {
                "error"
            } else if consumer.is_some() && feeding {
                "streaming"
            } else if ring.is_some() {
                "waiting"
            } else {
                "off"
            };
            VcamStatus {
                state,
                consumer,
                fps,
                registered,
                error: inner.error.clone(),
            }
        }

        fn configure(&self, config: OutputConfig) {
            let mut inner = self.lock();
            match inner.ring() {
                Some(ring) => ring.configure(config),
                None => inner.pending = Some(config),
            }
        }
    }

    /// COM registration of the media source (written by the setup helper).
    fn registered() -> bool {
        let key = HSTRING::from(format!("{}\\InprocServer32", clsid_key()));
        let mut size = 0u32;
        // SAFETY: size-only query of a REG_SZ value.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                &key,
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&raw mut size),
            )
        };
        status.is_ok() && size > 2
    }

    fn header(request: &Request<'_>, name: &str) -> Result<u32, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok())
            .ok_or_else(|| format!("missing or invalid {name} header"))
    }

    fn setup_exe(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let beside_exe = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(SETUP_EXE)));
        let in_resources = app
            .path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join(SETUP_EXE));
        beside_exe
            .into_iter()
            .chain(in_resources)
            .find(|path| path.metadata().is_ok_and(|m| m.len() > 0))
            .ok_or_else(|| format!("{SETUP_EXE} not found next to the app"))
    }

    /// Runs `exe install` elevated (UAC prompt) and waits for its exit code.
    fn run_elevated(exe: PathBuf) -> Result<u32, String> {
        let file = HSTRING::from(exe.as_os_str());
        let args = w!("install");
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: args,
            nShow: 0, // SW_HIDE: the helper is a console app.
            ..Default::default()
        };
        // SAFETY: info and the strings it points to outlive the call; the
        // returned process handle is waited on and closed here.
        unsafe {
            if let Err(error) = ShellExecuteExW(&mut info) {
                if error.code() == ERROR_CANCELLED.to_hresult() {
                    return Err("cancelled".into());
                }
                return Err(error.message());
            }
            if info.hProcess.is_invalid() {
                return Err("setup helper did not start".into());
            }
            let waited = WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 1u32;
            let exit = GetExitCodeProcess(info.hProcess, &mut code);
            let _ = CloseHandle(info.hProcess);
            if waited != WAIT_OBJECT_0 {
                return Err("waiting for the setup helper failed".into());
            }
            exit.map_err(|e| e.message())?;
            Ok(code)
        }
    }

    pub(super) fn frame(state: &VcamCtl, request: &Request<'_>) -> Result<(), String> {
        let InvokeBody::Raw(frame) = request.body() else {
            return Err("expected a raw NV12 body".into());
        };
        let width = header(request, "x-w")?;
        let height = header(request, "x-h")?;
        state.publish(width, height, frame)
    }

    /// Starts (once) the loopback frame server and returns its endpoint.
    pub(super) fn endpoint(state: &VcamCtl) -> Result<super::VcamEndpoint, String> {
        let mut slot = state
            .endpoint
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(ep) = slot.as_ref() {
            return Ok(ep.clone());
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = token();
        let ep = super::VcamEndpoint {
            port,
            token: token.clone(),
        };
        let shared = std::sync::Arc::clone(&state.inner);
        std::thread::Builder::new()
            .name("vcam-ws".into())
            .spawn(move || serve(listener, token, &shared))
            .map_err(|e| e.to_string())?;
        log::info!("vcam: frame socket on 127.0.0.1:{port}");
        *slot = Some(ep.clone());
        Ok(ep)
    }

    fn token() -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut out = String::new();
        for _ in 0..2 {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            out.push_str(&format!("{:016x}", h.finish()));
        }
        out
    }

    /// One studio connection at a time; each binary message is a frame.
    // The handshake callback's Err type is tungstenite's fixed `ErrorResponse`
    // (an http::Response); boxing it is not an option the API offers.
    #[allow(clippy::result_large_err)]
    fn serve(listener: std::net::TcpListener, token: String, shared: &Mutex<Inner>) {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_nodelay(true);
            let expected = format!("/{token}");
            let accepted = tungstenite::accept_hdr(
                stream,
                |req: &tungstenite::handshake::server::Request, res| {
                    if req.uri().path() == expected {
                        Ok(res)
                    } else {
                        let mut deny = tungstenite::handshake::server::ErrorResponse::new(Some(
                            "forbidden".into(),
                        ));
                        *deny.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                        Err(deny)
                    }
                },
            );
            let Ok(mut socket) = accepted else { continue };
            loop {
                match socket.read() {
                    Ok(tungstenite::Message::Binary(data)) => {
                        if data.len() < 8 {
                            continue;
                        }
                        let w = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                        let h = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
                        if let Err(error) = publish(shared, w, h, &data[8..]) {
                            log::warn!("vcam: frame rejected: {error}");
                        }
                    }
                    Ok(tungstenite::Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
    }

    pub(super) fn status(state: &VcamCtl) -> VcamStatus {
        state.status()
    }

    pub(super) fn configure(state: &VcamCtl, portrait: bool, fps: u32) -> Result<(), String> {
        let orientation = if portrait {
            Orientation::Portrait
        } else {
            Orientation::Landscape
        };
        let config =
            OutputConfig::new(orientation, fps).ok_or_else(|| format!("unsupported fps {fps}"))?;
        state.configure(config);
        Ok(())
    }

    pub(super) async fn register(app: tauri::AppHandle) -> Result<u32, String> {
        let exe = setup_exe(&app)?;
        log::info!("vcam: running {} install elevated", exe.display());
        let code = tauri::async_runtime::spawn_blocking(move || run_elevated(exe))
            .await
            .map_err(|e| e.to_string())??;
        log::info!("vcam: setup helper exited with {code}");
        Ok(code)
    }

    pub fn init(app: &tauri::AppHandle) {
        app.manage(VcamCtl::default());
    }
}

#[cfg(not(windows))]
mod imp {
    use super::VcamStatus;
    use tauri::Manager;

    #[derive(Default)]
    pub struct VcamCtl;

    pub(super) fn endpoint(_state: &VcamCtl) -> Result<super::VcamEndpoint, String> {
        Err("virtual camera is Windows-only".into())
    }

    pub(super) fn frame(
        _state: &VcamCtl,
        _request: &tauri::ipc::Request<'_>,
    ) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn status(_state: &VcamCtl) -> VcamStatus {
        VcamStatus {
            state: "unregistered",
            ..VcamStatus::default()
        }
    }

    pub(super) fn configure(_state: &VcamCtl, _portrait: bool, _fps: u32) -> Result<(), String> {
        Ok(())
    }

    pub(super) async fn register(_app: tauri::AppHandle) -> Result<u32, String> {
        Err("TikSee Camera is only available on Windows".into())
    }

    pub fn init(app: &tauri::AppHandle) {
        app.manage(VcamCtl);
    }
}
