//! Native camera control (decision Q42). Two transports:
//! - `ble`: Sony Bluetooth remote. Default while live: it leaves HDMI alone.
//! - USB PC Remote (PTP + Sony SDIO): full property access, but on ZV-E10 the
//!   SDIO session blanks HDMI output, so it is opt-in (`TIKSEE_CAMERA_CTL=usb`)
//!   and meant for setup before going live.

pub mod ble;
pub mod ptp;
#[cfg(windows)]
mod usbk;

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};
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
    pub connected: bool,
    pub model: String,
    pub firmware: String,
    pub error: Option<String>,
    pub props: Vec<PropView>,
}

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
    Refresh,
    Shutdown,
}

pub struct CameraCtl {
    tx: Mutex<Option<Sender<Req>>>,
}

impl Default for CameraCtl {
    fn default() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }
}

impl CameraCtl {
    fn send(&self, r: Req) -> Result<(), String> {
        let guard = self.tx.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or("camera control is not running")?
            .send(r)
            .map_err(|e| e.to_string())
    }

    pub fn start(&self, app: &AppHandle) {
        let mut guard = self.tx.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let (tx, rx) = channel();
        *guard = Some(tx);
        let app = app.clone();
        std::thread::Builder::new()
            .name("camera-ctl".into())
            .spawn(move || worker(app, rx))
            .ok();
    }

    pub fn stop(&self) {
        if let Ok(mut g) = self.tx.lock()
            && let Some(tx) = g.take()
        {
            let _ = tx.send(Req::Shutdown);
        }
    }
}

fn emit(app: &AppHandle, state: &CameraState) {
    let _ = app.emit("camera://state", state);
}

#[cfg(windows)]
fn worker(app: AppHandle, rx: Receiver<Req>) {
    use session::Session;
    let mut state = CameraState {
        transport: "none".into(),
        ..Default::default()
    };
    let mut session: Option<Session> = None;
    let mut last_try = Instant::now() - Duration::from_secs(10);
    let mut last_poll = Instant::now();
    loop {
        // Connect (or reconnect) every 3 s while disconnected.
        if session.is_none() && last_try.elapsed() >= Duration::from_secs(3) {
            last_try = Instant::now();
            match Session::open_usb() {
                Ok((s, model, fw)) => {
                    log::info!("[camera] connected over USB: {model} fw {fw}");
                    state = CameraState {
                        transport: "usb".into(),
                        connected: true,
                        model,
                        firmware: fw,
                        ..Default::default()
                    };
                    session = Some(s);
                    last_poll = Instant::now() - Duration::from_secs(5);
                }
                Err(e) => {
                    if state.error.as_deref() != Some(e.as_str()) {
                        log::info!("[camera] not connected: {e}");
                        state = CameraState {
                            transport: "none".into(),
                            error: Some(e),
                            ..Default::default()
                        };
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
                Ok(Req::Shutdown) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                _ => continue,
            }
        };
        let result = match req {
            Ok(Req::Shutdown) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                s.close();
                return;
            }
            Ok(Req::Control(c, v)) => s.control(c.code(), &c.payload(v)),
            Ok(Req::SetProp(code, v)) => {
                let dtype = state
                    .props
                    .iter()
                    .find(|p| p.code == code)
                    .map(|_| s.dtype(code))
                    .unwrap_or(None);
                match dtype.and_then(|t| t.encode(v)) {
                    Some(bytes) => s.set_prop(code, &bytes),
                    None => Err(format!("property 0x{code:04x} is unknown or not numeric")),
                }
            }
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
                    state = CameraState {
                        transport: "none".into(),
                        error: Some(e),
                        ..Default::default()
                    };
                    emit(&app, &state);
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn worker(app: AppHandle, _rx: Receiver<Req>) {
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
        pub fn open_usb() -> Result<(Self, String, String), String> {
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
            // SDIO handshake (libgphoto2 / Sony Camera Remote Command order).
            s.call(ptp::OP_SDIO_CONNECT, &[1, 0, 0], None)?;
            s.call(ptp::OP_SDIO_CONNECT, &[2, 0, 0], None)?;
            s.call(ptp::OP_SDIO_GET_EXT_DEVICE_INFO, &[ptp::SDIO_VERSION], None)?;
            s.call(ptp::OP_SDIO_CONNECT, &[3, 0, 0], None)?;
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
}
