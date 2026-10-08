//! Native camera control (decision Q42). Two transports:
//! - `ble`: Sony Bluetooth remote. Default while live: it leaves HDMI alone.
//! - USB PC Remote (PTP + Sony SDIO): full property access, but on ZV-E10 the
//!   SDIO session blanks HDMI output, so it is opt-in (`TIKSEE_CAMERA_CTL=usb`
//!   or `camera_usb_start`) and meant for setup before going live.
//!   `probe` mode skips SDIO GetExtDeviceInfo (0x9202), the op that blanks
//!   HDMI (Q43), and reports `probeFailed` if the camera then refuses SDIO.

pub mod ble;
pub mod ptp;
#[cfg(windows)]
mod usbk;

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use ptp::{Form, Prop};

/// Properties the UI understands, by Sony SDIO code (verified on ZV-E10 fw 2.02).
pub const KNOWN: &[(u16, &str)] = &[
    (0x5005, "whiteBalance"),
    (0x5007, "fNumber"),
    (0x500A, "focusMode"),
    (0x500B, "metering"),
    (0x500E, "exposureMode"),
    (0x5010, "exposureBias"),
    (0xD20D, "shutterSpeed"),
    (0xD20F, "colorTemp"),
    (0xD213, "focusFound"),
    (0xD218, "battery"),
    (0xD21D, "movieRecording"),
    (0xD21E, "iso"),
    (0xD23F, "pictureProfile"),
    (0xD240, "creativeStyle"),
    (0xD25C, "zoomScale"),
    (0xD25D, "zoomPosition"),
];

/// Momentary / hold controls sent with SDIO_ControlDevice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Control {
    /// INT8 speed: >0 tele, <0 wide, 0 stop.
    Zoom,
    /// Focus step toward near; value = steps (1..7).
    FocusNear,
    /// Focus step toward far; value = steps (1..7).
    FocusFar,
    /// Half press (AF): 2 = down, 1 = up.
    HalfPress,
    /// Full press (shutter): 2 = down, 1 = up.
    FullPress,
    /// Movie record button: 2 = down, 1 = up.
    Record,
}

impl Control {
    fn code(self) -> u16 {
        match self {
            Self::Zoom => 0xD2DD,
            Self::FocusNear => 0xD2D7,
            Self::FocusFar => 0xD2D8,
            Self::HalfPress => 0xD2C1,
            Self::FullPress => 0xD2C2,
            Self::Record => 0xD2C8,
        }
    }

    /// Wire payload. Zoom is INT8; focus steps are INT16; buttons are UINT16.
    fn payload(self, value: i32) -> Vec<u8> {
        match self {
            Self::Zoom => vec![value.clamp(-127, 127) as i8 as u8],
            Self::FocusNear | Self::FocusFar => (value.clamp(1, 7) as i16).to_le_bytes().to_vec(),
            _ => (value.clamp(1, 2) as u16).to_le_bytes().to_vec(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PropView {
    pub code: u16,
    pub name: String,
    pub writable: bool,
    pub enabled: bool,
    pub value: Option<i64>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub step: Option<i64>,
    pub options: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    /// "usb" when connected, "none" otherwise.
    pub transport: String,
    /// Which USB session is running: off, full (HDMI blanks) or probe (no 0x9202).
    pub mode: Mode,
    pub connected: bool,
    pub model: String,
    pub firmware: String,
    pub error: Option<String>,
    /// Probe mode only: the camera refused SDIO without 0x9202 (PTP response
    /// code such as "0x2005", or the transport error). The session is closed.
    pub probe_failed: Option<String>,
    pub props: Vec<PropView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Full,
    Probe,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbStatus {
    pub running: bool,
    pub mode: Mode,
    pub state: Option<CameraState>,
}

/// SDIO ops sent after OpenSession (libgphoto2 / Sony Camera Remote Command
/// order). Probe mode drops GetExtDeviceInfo (0x9202), which blanks HDMI (Q43).
#[cfg_attr(not(windows), allow(dead_code))]
fn handshake_ops(probe: bool) -> Vec<(u16, Vec<u32>)> {
    let mut ops = vec![
        (ptp::OP_SDIO_CONNECT, vec![1, 0, 0]),
        (ptp::OP_SDIO_CONNECT, vec![2, 0, 0]),
    ];
    if !probe {
        ops.push((ptp::OP_SDIO_GET_EXT_DEVICE_INFO, vec![ptp::SDIO_VERSION]));
    }
    ops.push((ptp::OP_SDIO_CONNECT, vec![3, 0, 0]));
    ops
}

/// PTP response code from a `Session::call` error ("op 0x9209 -> 0x2005").
#[cfg_attr(not(windows), allow(dead_code))]
fn response_code(error: &str) -> Option<String> {
    let code = error.rsplit_once("-> ")?.1.trim();
    (code.starts_with("0x") && code.len() == 6).then(|| code.to_string())
}

/// Next (`dir > 0`) or previous option for a property: walks the camera's own
/// option list for enumerations, or `value ± step` within a range. `None` at
/// the end of the list or when the property is not writable.
#[cfg_attr(not(windows), allow(dead_code))]
fn step_option(p: &PropView, dir: i32) -> Option<i64> {
    if !p.writable || dir == 0 {
        return None;
    }
    if !p.options.is_empty() {
        let Some(i) = p.value.and_then(|v| p.options.iter().position(|o| *o == v)) else {
            return p.options.first().copied();
        };
        let j = if dir > 0 {
            i.checked_add(1)?
        } else {
            i.checked_sub(1)?
        };
        return p.options.get(j).copied();
    }
    let (min, max) = (p.min?, p.max?);
    let step = p.step.filter(|s| *s > 0).unwrap_or(1);
    let v = p.value.unwrap_or(min);
    let next = (v + step * i64::from(dir.signum())).clamp(min, max);
    (next != v).then_some(next)
}

static LAST: Mutex<Option<CameraState>> = Mutex::new(None);

fn view(p: &Prop) -> PropView {
    let name = KNOWN
        .iter()
        .find(|(c, _)| *c == p.code)
        .map(|(_, n)| (*n).to_string())
        .unwrap_or_default();
    let (min, max, step, options) = match &p.form {
        Form::Range { min, max, step } => (Some(*min), Some(*max), Some(*step), vec![]),
        Form::Enum(v) => (None, None, None, v.clone()),
        Form::None => (None, None, None, vec![]),
    };
    PropView {
        code: p.code,
        name,
        writable: p.writable,
        enabled: p.enabled,
        value: p.current,
        min,
        max,
        step,
        options,
    }
}

enum Req {
    Control(Control, i32),
    SetProp(u16, i64),
    Step(u16, i32),
    Refresh,
    Shutdown,
}

struct Running {
    tx: Sender<Req>,
    mode: Mode,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct CameraCtl {
    run: Mutex<Option<Running>>,
}

impl CameraCtl {
    fn send(&self, r: Req) -> Result<(), String> {
        let guard = self.run.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or("camera control is not running")?
            .tx
            .send(r)
            .map_err(|e| e.to_string())
    }

    /// Env-var path (`TIKSEE_CAMERA_CTL=usb`): full handshake.
    pub fn start(&self, app: &AppHandle) {
        if let Err(e) = self.start_mode(app, Mode::Full) {
            log::warn!("[camera] start failed: {e}");
        }
    }

    /// Start (or switch to) a USB session in `mode`. Switching modes closes the
    /// running session first so the camera sees a fresh handshake.
    pub fn start_mode(&self, app: &AppHandle, mode: Mode) -> Result<(), String> {
        let mut guard = self.run.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(r) if r.mode == mode => return Ok(()),
            Some(_) => halt(guard.take(), true),
            None => {}
        }
        if mode == Mode::Off {
            return Ok(());
        }
        let (tx, rx) = channel();
        let app = app.clone();
        let probe = mode == Mode::Probe;
        let handle = std::thread::Builder::new()
            .name("camera-ctl".into())
            .spawn(move || worker(app, rx, probe))
            .map_err(|e| e.to_string())?;
        *guard = Some(Running {
            tx,
            mode,
            handle: Some(handle),
        });
        Ok(())
    }

    /// Stop without waiting (app exit).
    pub fn stop(&self) {
        if let Ok(mut g) = self.run.lock() {
            halt(g.take(), false);
        }
    }

    /// Stop and wait for the worker to close the PTP session.
    pub fn stop_wait(&self) {
        if let Ok(mut g) = self.run.lock() {
            halt(g.take(), true);
        }
    }

    pub fn status(&self) -> UsbStatus {
        let mode = self
            .run
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|r| r.mode))
            .unwrap_or(Mode::Off);
        UsbStatus {
            running: mode != Mode::Off,
            mode,
            state: LAST.lock().ok().and_then(|g| g.clone()),
        }
    }
}

fn halt(run: Option<Running>, wait: bool) {
    let Some(mut r) = run else { return };
    let _ = r.tx.send(Req::Shutdown);
    if wait && let Some(h) = r.handle.take() {
        let _ = h.join();
    }
}

fn emit(app: &AppHandle, state: &CameraState) {
    if let Ok(mut g) = LAST.lock() {
        *g = Some(state.clone());
    }
    let _ = app.emit("camera://state", state);
}

/// Final state once the worker exits.
fn emit_off(app: &AppHandle) {
    emit(
        app,
        &CameraState {
            transport: "none".into(),
            ..Default::default()
        },
    );
}

#[cfg(windows)]
fn worker(app: AppHandle, rx: Receiver<Req>, probe: bool) {
    use session::Session;
    let mode = if probe { Mode::Probe } else { Mode::Full };
    let idle = |error: Option<String>| CameraState {
        transport: "none".into(),
        mode,
        error,
        ..Default::default()
    };
    let mut state = idle(None);
    emit(&app, &state);
    let mut session: Option<Session> = None;
    // Probe refused by the camera: stay disconnected (never fall back to 0x9202).
    let mut refused = false;
    let mut last_try = Instant::now() - Duration::from_secs(10);
    let mut last_poll = Instant::now();
    loop {
        // Connect (or reconnect) every 3 s while disconnected.
        if session.is_none() && !refused && last_try.elapsed() >= Duration::from_secs(3) {
            last_try = Instant::now();
            let opened = Session::open_usb(probe).and_then(|(mut s, model, fw)| {
                if probe && let Err(e) = s.props() {
                    s.close();
                    return Err(e);
                }
                Ok((s, model, fw))
            });
            match opened {
                Ok((s, model, fw)) => {
                    log::info!("[camera] connected over USB ({mode:?}): {model} fw {fw}");
                    state = CameraState {
                        transport: "usb".into(),
                        mode,
                        connected: true,
                        model,
                        firmware: fw,
                        ..Default::default()
                    };
                    session = Some(s);
                    last_poll = Instant::now() - Duration::from_secs(5);
                }
                Err(e) if probe && response_code(&e).is_some() => {
                    log::warn!("[camera] probe refused: {e}");
                    refused = true;
                    state = CameraState {
                        probe_failed: response_code(&e),
                        ..idle(Some(e))
                    };
                    emit(&app, &state);
                }
                Err(e) => {
                    if state.error.as_deref() != Some(e.as_str()) {
                        log::info!("[camera] not connected: {e}");
                        state = idle(Some(e));
                        emit(&app, &state);
                    }
                }
            }
        }
        let wait = if session.is_some() {
            Duration::from_millis(250)
        } else {
            Duration::from_secs(1)
        };
        let req = rx.recv_timeout(wait);
        let Some(s) = session.as_mut() else {
            match req {
                Ok(Req::Shutdown) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    emit_off(&app);
                    return;
                }
                _ => continue,
            }
        };
        let set = |s: &mut Session, code: u16, v: i64| match s.dtype(code).and_then(|t| t.encode(v))
        {
            Some(bytes) => s.set_prop(code, &bytes),
            None => Err(format!("property 0x{code:04x} is unknown or not numeric")),
        };
        let result = match req {
            Ok(Req::Shutdown) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                s.close();
                emit_off(&app);
                return;
            }
            Ok(Req::Control(c, v)) => s.control(c.code(), &c.payload(v)),
            Ok(Req::SetProp(code, v)) => set(s, code, v),
            Ok(Req::Step(code, dir)) => match state.props.iter().find(|p| p.code == code) {
                None => Err(format!(
                    "property 0x{code:04x} is not reported by the camera"
                )),
                Some(p) => match step_option(p, dir) {
                    Some(v) => set(s, code, v).map(|()| {
                        last_poll = Instant::now() - Duration::from_secs(5);
                    }),
                    None => Err(format!("0x{code:04x}: no further value")),
                },
            },
            Ok(Req::Refresh) => {
                last_poll = Instant::now() - Duration::from_secs(5);
                Ok(())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(()),
        };
        if let Err(e) = result {
            log::warn!("[camera] request failed: {e}");
            state.error = Some(e);
            emit(&app, &state);
        }
        // Poll properties every 1 s (cheap: one 2.7 KB transfer).
        if last_poll.elapsed() >= Duration::from_secs(1) {
            last_poll = Instant::now();
            match s.props() {
                Ok(props) => {
                    state.props = props.iter().map(view).collect();
                    state.error = None;
                    emit(&app, &state);
                }
                Err(e) => {
                    log::warn!("[camera] lost: {e}");
                    session = None;
                    state = idle(Some(e));
                    emit(&app, &state);
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn worker(app: AppHandle, _rx: Receiver<Req>, _probe: bool) {
    emit(
        &app,
        &CameraState {
            transport: "none".into(),
            error: Some("camera control is Windows-only".into()),
            ..Default::default()
        },
    );
}

#[cfg(windows)]
mod session {
    use std::time::Duration;

    use super::ptp::{self, DataType, Prop};
    use super::usbk::{UsbDevice, find_paths};

    /// Sony PC Remote (USB) product id on ZV-E10.
    const SONY_PC_REMOTE: &str = "vid_054c&pid_0d97";

    pub struct Session {
        dev: UsbDevice,
        tid: u32,
        props: Vec<Prop>,
    }

    impl Session {
        pub fn open_usb(probe: bool) -> Result<(Self, String, String), String> {
            let path = find_paths(SONY_PC_REMOTE)
                .into_iter()
                .next()
                .ok_or("no Sony camera in PC Remote (USB) mode")?;
            let dev = UsbDevice::open(&path, Duration::from_secs(5))?;
            let mut s = Self {
                dev,
                tid: 0,
                props: Vec::new(),
            };
            // A previous process (dev relaunch, crash) may have left the session
            // open on the camera: 0x201E SessionAlreadyOpen. Close it and retry.
            if let Err(e) = s.call(ptp::OP_OPEN_SESSION, &[1], None) {
                if !e.ends_with("0x201e") {
                    return Err(e);
                }
                log::info!("[camera] stale session on camera, closing it");
                let _ = s.call(ptp::OP_CLOSE_SESSION, &[], None);
                s.call(ptp::OP_OPEN_SESSION, &[1], None)?;
            }
            let info = s.call(ptp::OP_GET_DEVICE_INFO, &[], None)?;
            let (model, fw) = device_strings(&info);
            for (op, params) in super::handshake_ops(probe) {
                if let Err(e) = s.call(op, &params, None) {
                    s.close();
                    return Err(e);
                }
            }
            Ok((s, model, fw))
        }

        pub fn props(&mut self) -> Result<Vec<Prop>, String> {
            let data = self.call(ptp::OP_SDIO_GET_ALL_EXT_PROP_INFO, &[], None)?;
            self.props = ptp::parse_all_props(&data)?;
            Ok(self.props.clone())
        }

        pub fn dtype(&self, code: u16) -> Option<DataType> {
            self.props.iter().find(|p| p.code == code).map(|p| p.dtype)
        }

        pub fn control(&mut self, code: u16, payload: &[u8]) -> Result<(), String> {
            self.call(ptp::OP_SDIO_CONTROL_DEVICE, &[code as u32], Some(payload))
                .map(|_| ())
        }

        pub fn set_prop(&mut self, code: u16, payload: &[u8]) -> Result<(), String> {
            self.call(ptp::OP_SDIO_SET_EXT_PROP, &[code as u32], Some(payload))
                .map(|_| ())
        }

        pub fn close(&mut self) {
            let _ = self.call(ptp::OP_CLOSE_SESSION, &[], None);
        }

        /// One PTP transaction; returns the data phase (if any).
        fn call(
            &mut self,
            code: u16,
            params: &[u32],
            data_out: Option<&[u8]>,
        ) -> Result<Vec<u8>, String> {
            self.tid += 1;
            self.dev.write(&ptp::command(code, self.tid, params))?;
            if let Some(d) = data_out {
                self.dev
                    .write(&ptp::container(ptp::CONTAINER_DATA, code, self.tid, d))?;
            }
            let mut data = Vec::new();
            loop {
                let pkt = self.read_container()?;
                let h = ptp::header(&pkt).ok_or("short PTP container")?;
                match h.kind {
                    ptp::CONTAINER_DATA => data.extend_from_slice(&pkt[12..]),
                    ptp::CONTAINER_RESPONSE if h.code == ptp::RESP_OK => return Ok(data),
                    ptp::CONTAINER_RESPONSE => {
                        return Err(format!("op 0x{code:04x} -> 0x{:04x}", h.code));
                    }
                    k => return Err(format!("unexpected PTP container type {k}")),
                }
            }
        }

        fn read_container(&mut self) -> Result<Vec<u8>, String> {
            let mut buf = vec![0u8; 64 * 1024];
            let n = self.dev.read(&mut buf)?;
            let total = ptp::header(&buf[..n]).ok_or("short PTP container")?.len as usize;
            buf.truncate(n);
            while buf.len() < total {
                let mut more = vec![0u8; (total - buf.len()).max(512)];
                let m = self.dev.read(&mut more)?;
                buf.extend_from_slice(&more[..m]);
            }
            Ok(buf)
        }
    }

    /// Manufacturer/model/firmware from a PTP DeviceInfo dataset.
    fn device_strings(d: &[u8]) -> (String, String) {
        fn string(d: &[u8], o: &mut usize) -> String {
            let n = *d.get(*o).unwrap_or(&0) as usize;
            *o += 1;
            let units: Vec<u16> = (0..n)
                .filter_map(|i| {
                    d.get(*o + 2 * i..*o + 2 * i + 2)
                        .map(|s| u16::from_le_bytes([s[0], s[1]]))
                })
                .collect();
            *o += 2 * n;
            String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string()
        }
        fn list(d: &[u8], o: &mut usize) {
            let n = d
                .get(*o..*o + 4)
                .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
                .unwrap_or(0) as usize;
            *o += 4 + 2 * n;
        }
        let mut o = 8;
        let _ = string(d, &mut o);
        o += 2;
        for _ in 0..5 {
            list(d, &mut o);
        }
        let _manufacturer = string(d, &mut o);
        let model = string(d, &mut o);
        let fw = string(d, &mut o);
        (model, fw)
    }
}

/* ------------------------------ commands ------------------------------ */

#[tauri::command]
pub fn camera_control(
    state: tauri::State<'_, CameraCtl>,
    control: Control,
    value: i32,
) -> Result<(), String> {
    state.send(Req::Control(control, value))
}

#[tauri::command]
pub fn camera_set(state: tauri::State<'_, CameraCtl>, code: u16, value: i64) -> Result<(), String> {
    if !KNOWN.iter().any(|(c, _)| *c == code) {
        return Err(format!("property 0x{code:04x} is not exposed"));
    }
    state.send(Req::SetProp(code, value))
}

#[tauri::command]
pub fn camera_refresh(state: tauri::State<'_, CameraCtl>) -> Result<(), String> {
    state.send(Req::Refresh)
}

/// Step a property to the next (`dir = 1`) or previous (`dir = -1`) value the
/// camera offers, so the UI never needs to know Sony's encodings.
#[tauri::command]
pub fn camera_set_step(
    state: tauri::State<'_, CameraCtl>,
    code: u16,
    dir: i32,
) -> Result<(), String> {
    if !KNOWN.iter().any(|(c, _)| *c == code) {
        return Err(format!("property 0x{code:04x} is not exposed"));
    }
    if dir != 1 && dir != -1 {
        return Err("dir must be 1 or -1".into());
    }
    state.send(Req::Step(code, dir))
}

/// Start the USB PC Remote session at runtime. `probe = true` skips SDIO
/// GetExtDeviceInfo (0x9202, blanks HDMI); `false` is the full handshake.
#[tauri::command]
pub fn camera_usb_start(
    app: AppHandle,
    state: tauri::State<'_, CameraCtl>,
    probe: bool,
) -> Result<(), String> {
    state.start_mode(&app, if probe { Mode::Probe } else { Mode::Full })
}

/// Close the USB session (HDMI comes back after a full session).
#[tauri::command]
pub async fn camera_usb_stop(state: tauri::State<'_, CameraCtl>) -> Result<(), String> {
    state.stop_wait();
    Ok(())
}

#[tauri::command]
pub fn camera_usb_status(state: tauri::State<'_, CameraCtl>) -> UsbStatus {
    state.status()
}

#[tauri::command]
pub fn camera_ble(
    state: tauri::State<'_, ble::BleCtl>,
    action: ble::BleAction,
    value: i32,
) -> Result<(), String> {
    state.send(action, value)
}

/// Current Bluetooth remote state (the `camera://ble` event only fires on change).
#[tauri::command]
pub fn camera_ble_state() -> Option<ble::BleState> {
    ble::last_state()
}

pub fn shutdown(app: &AppHandle) {
    if let Some(c) = app.try_state::<CameraCtl>() {
        c.stop();
    }
    if let Some(c) = app.try_state::<ble::BleCtl>() {
        c.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_payloads_match_wire_types() {
        assert_eq!(Control::Zoom.payload(1), vec![1]);
        assert_eq!(Control::Zoom.payload(-1), vec![0xFF]);
        assert_eq!(Control::Zoom.payload(500), vec![127]);
        assert_eq!(Control::FocusNear.payload(3), vec![3, 0]);
        assert_eq!(Control::Record.payload(2), vec![2, 0]);
        assert_eq!(Control::HalfPress.payload(9), vec![2, 0]);
    }

    #[test]
    fn view_names_known_props_and_flattens_forms() {
        let p = Prop {
            code: 0xD21E,
            dtype: ptp::DataType::U32,
            writable: true,
            enabled: true,
            current: Some(800),
            text: None,
            form: Form::Enum(vec![100, 200, 800]),
        };
        let v = view(&p);
        assert_eq!(v.name, "iso");
        assert_eq!(v.options, vec![100, 200, 800]);
        assert_eq!(v.value, Some(800));
    }

    fn prop(value: Option<i64>, options: Vec<i64>) -> PropView {
        PropView {
            code: 0xD21E,
            name: "iso".into(),
            writable: true,
            enabled: true,
            value,
            options,
            ..Default::default()
        }
    }

    #[test]
    fn step_walks_enum_options_and_stops_at_the_ends() {
        let p = prop(Some(200), vec![100, 200, 800]);
        assert_eq!(step_option(&p, 1), Some(800));
        assert_eq!(step_option(&p, -1), Some(100));
        assert_eq!(step_option(&prop(Some(800), vec![100, 200, 800]), 1), None);
        assert_eq!(step_option(&prop(Some(100), vec![100, 200, 800]), -1), None);
        // Current value outside the list: jump to the first option.
        assert_eq!(step_option(&prop(Some(5), vec![100, 200]), 1), Some(100));
    }

    #[test]
    fn step_respects_ranges_and_read_only() {
        let mut p = prop(Some(5600), vec![]);
        p.min = Some(2500);
        p.max = Some(9900);
        p.step = Some(100);
        assert_eq!(step_option(&p, 1), Some(5700));
        assert_eq!(step_option(&p, -1), Some(5500));
        p.value = Some(9900);
        assert_eq!(step_option(&p, 1), None);
        p.writable = false;
        assert_eq!(step_option(&p, -1), None);
    }

    #[test]
    fn probe_handshake_skips_get_ext_device_info() {
        let full: Vec<u16> = handshake_ops(false).iter().map(|(op, _)| *op).collect();
        let probe: Vec<u16> = handshake_ops(true).iter().map(|(op, _)| *op).collect();
        assert_eq!(full, vec![0x9201, 0x9201, 0x9202, 0x9201]);
        assert_eq!(probe, vec![0x9201, 0x9201, 0x9201]);
        assert_eq!(handshake_ops(true)[2].1, vec![3, 0, 0]);
    }

    #[test]
    fn response_code_parses_ptp_errors_only() {
        assert_eq!(
            response_code("op 0x9209 -> 0x2005").as_deref(),
            Some("0x2005")
        );
        assert_eq!(
            response_code("no Sony camera in PC Remote (USB) mode"),
            None
        );
    }

    #[test]
    fn mode_serialises_lowercase() {
        assert_eq!(serde_json::to_string(&Mode::Probe).unwrap(), "\"probe\"");
        assert_eq!(serde_json::to_string(&Mode::Off).unwrap(), "\"off\"");
    }
}
