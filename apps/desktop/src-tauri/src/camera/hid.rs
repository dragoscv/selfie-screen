//! Bluetooth HID buttons (phone selfie-stick remotes: arrows, OK, shutter) as
//! camera buttons. The remote pairs with Windows as a keyboard / consumer
//! control; a message-only window reads it through Raw Input (works while
//! TikSee is in the background). Only the device learned in the remote window
//! is listened to, so the real keyboard never moves the lens. Raw Input does
//! not swallow keys: the focused app still sees them (volume still changes).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::remote::{self, Action, Transport};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub key: String,
    pub action: Action,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HidConfig {
    pub enabled: bool,
    /// Raw Input device path of the learned remote; empty = listen to nothing.
    pub device: String,
    pub bindings: Vec<Binding>,
    pub transport: Transport,
    pub speed: u8,
}

/// Payload of `camera://hid-learn` (a button pressed while learning).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HidPress {
    pub device: String,
    pub key: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Learn,
    Dispatch(Action),
    Ignore,
}

pub fn decide(cfg: &HidConfig, learning: bool, device: &str, key: &str) -> Decision {
    if learning {
        return Decision::Learn;
    }
    if !cfg.enabled || cfg.device.is_empty() || cfg.device != device {
        return Decision::Ignore;
    }
    cfg.bindings
        .iter()
        .find(|b| b.key == key)
        .map_or(Decision::Ignore, |b| Decision::Dispatch(b.action))
}

/// Key id of a consumer-control report, `None` for the all-zero release report.
pub fn hid_key(report: &[u8]) -> Option<String> {
    let payload = report.get(1..).unwrap_or_default();
    if payload.iter().all(|b| *b == 0) {
        return None;
    }
    Some(format!(
        "hid:{}",
        report
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<String>()
    ))
}

pub fn vk_key(vkey: u16) -> String {
    format!("vk:{vkey:02X}")
}

/// Selfie remotes often send press and release within ~30 ms of a tap; a zoom
/// or focus hold that short barely moves the lens, so a tap lasts this long.
pub const MIN_HOLD: Duration = Duration::from_millis(300);

/// How long to wait before sending the release of a hold pressed at `since`.
pub fn release_delay(since: Option<Instant>, now: Instant) -> Duration {
    since.map_or(Duration::ZERO, |t| {
        MIN_HOLD.saturating_sub(now.duration_since(t))
    })
}

#[derive(Default)]
struct Inner {
    config: HidConfig,
    learning: bool,
}

#[derive(Default)]
pub struct HidCtl {
    inner: Arc<Mutex<Inner>>,
    started: AtomicBool,
}

impl HidCtl {
    pub fn configure(&self, app: &AppHandle, config: HidConfig) {
        let enabled = config.enabled;
        if let Ok(mut g) = self.inner.lock() {
            g.config = config;
        }
        if enabled {
            self.ensure(app);
        }
    }

    pub fn learn(&self, app: &AppHandle, on: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.learning = on;
        }
        if on {
            self.ensure(app);
        }
    }

    fn ensure(&self, app: &AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        let inner = self.inner.clone();
        let spawned = std::thread::Builder::new()
            .name("camera-hid".into())
            .spawn(move || {
                if let Err(e) = listen(&app, &inner) {
                    log::warn!("[camera] selfie remote listener: {e}");
                    let _ = app.emit("camera://hid-error", e);
                }
            });
        if spawned.is_err() {
            self.started.store(false, Ordering::SeqCst);
        }
    }
}

/// Edge tracking shared by the keyboard and consumer paths.
#[derive(Default)]
struct Edges {
    keys_down: HashSet<(String, String)>,
    hid_down: HashMap<String, String>,
}

impl Edges {
    /// Keyboard: drop auto-repeat downs and ups for keys never seen down.
    fn key(&mut self, device: &str, key: String, down: bool) -> Vec<(String, bool)> {
        let id = (device.to_string(), key.clone());
        let fresh = if down {
            self.keys_down.insert(id)
        } else {
            self.keys_down.remove(&id)
        };
        if fresh { vec![(key, down)] } else { vec![] }
    }

    /// Consumer control: a report replaces the previous one from that device.
    fn report(&mut self, device: &str, key: Option<String>) -> Vec<(String, bool)> {
        let prev = self.hid_down.get(device).cloned();
        if prev == key {
            return vec![];
        }
        let mut out = Vec::new();
        if let Some(p) = prev {
            out.push((p, false));
        }
        match key {
            Some(k) => {
                self.hid_down.insert(device.to_string(), k.clone());
                out.push((k, true));
            }
            None => {
                self.hid_down.remove(device);
            }
        }
        out
    }
}

fn on_edge(
    app: &AppHandle,
    inner: &Mutex<Inner>,
    pressed: &mut HashMap<Action, Instant>,
    device: &str,
    key: String,
    down: bool,
) {
    let Ok(g) = inner.lock() else { return };
    let decision = decide(&g.config, g.learning, device, &key);
    let (transport, speed) = (g.config.transport, g.config.speed);
    drop(g);
    match decision {
        Decision::Learn if down => {
            let _ = app.emit(
                "camera://hid-learn",
                HidPress {
                    device: device.to_string(),
                    key,
                },
            );
        }
        Decision::Dispatch(action) => {
            let delay = if down {
                pressed.insert(action, Instant::now());
                Duration::ZERO
            } else {
                release_delay(pressed.remove(&action), Instant::now())
            };
            let send = move |app: &AppHandle| {
                if let Err(e) = remote::dispatch(app, action, down, speed, transport) {
                    log::warn!("[camera] selfie remote {action:?}: {e}");
                }
            };
            if delay.is_zero() || !action.is_hold() {
                send(app);
            } else {
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    send(&app);
                });
            }
        }
        _ => {}
    }
}

#[cfg(windows)]
fn listen(app: &AppHandle, inner: &Mutex<Inner>) -> Result<(), String> {
    use std::mem::size_of;

    use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
        RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RIDI_DEVICENAME, RIM_TYPEHID, RIM_TYPEKEYBOARD,
        RegisterRawInputDevices,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RI_KEY_BREAK,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT,
    };
    use windows::core::w;

    fn device_name(h: HANDLE) -> Option<String> {
        let mut n = 0u32;
        // SAFETY: size query with a null buffer.
        unsafe { GetRawInputDeviceInfoW(Some(h), RIDI_DEVICENAME, None, &mut n) };
        if n == 0 {
            return None;
        }
        let mut buf = vec![0u16; n as usize];
        // SAFETY: buf holds n UTF-16 units as requested.
        let got = unsafe {
            GetRawInputDeviceInfoW(
                Some(h),
                RIDI_DEVICENAME,
                Some(buf.as_mut_ptr().cast()),
                &mut n,
            )
        };
        if got == u32::MAX || got == 0 {
            return None;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    // SAFETY: plain Win32 calls on this thread; the window is message-only and
    // owned by this thread for its whole life.
    let hwnd: HWND = unsafe {
        let module = GetModuleHandleW(None).map_err(|e| e.message())?;
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("TikSee selfie remote"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(HINSTANCE(module.0)),
            None,
        )
        .map_err(|e| e.message())?
    };
    let devices = [
        // Keyboard: arrows / Enter / volume keys of HID remotes.
        RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x06,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        },
        // Consumer control: the shutter button of most selfie remotes (Volume Up).
        RAWINPUTDEVICE {
            usUsagePage: 0x0C,
            usUsage: 0x01,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        },
    ];
    // SAFETY: valid array of RAWINPUTDEVICE with the correct element size.
    unsafe { RegisterRawInputDevices(&devices, size_of::<RAWINPUTDEVICE>() as u32) }
        .map_err(|e| e.message())?;
    log::info!("[camera] selfie remote listener ready");

    let mut names: HashMap<isize, String> = HashMap::new();
    let mut edges = Edges::default();
    let mut pressed: HashMap<Action, Instant> = HashMap::new();
    let header = size_of::<RAWINPUTHEADER>() as u32;
    let mut msg = MSG::default();
    // SAFETY: standard message loop on the thread that owns `hwnd`.
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        if msg.message == WM_INPUT {
            let h = HRAWINPUT(msg.lParam.0 as _);
            let mut size = 0u32;
            // SAFETY: size query, then a buffer of at least `size` bytes, 8-byte aligned.
            unsafe { GetRawInputData(h, RID_INPUT, None, &mut size, header) };
            let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
            let got = unsafe {
                GetRawInputData(
                    h,
                    RID_INPUT,
                    Some(buf.as_mut_ptr().cast()),
                    &mut size,
                    header,
                )
            };
            if got != u32::MAX && got as usize >= size_of::<RAWINPUTHEADER>() {
                // SAFETY: the buffer holds a RAWINPUT written by the system.
                let raw = unsafe { &*buf.as_ptr().cast::<RAWINPUT>() };
                let handle = raw.header.hDevice;
                if !handle.is_invalid() {
                    let name = names
                        .entry(handle.0 as isize)
                        .or_insert_with(|| device_name(handle).unwrap_or_default())
                        .clone();
                    let out = if raw.header.dwType == RIM_TYPEKEYBOARD.0 {
                        // SAFETY: dwType says the union holds a keyboard record.
                        let k = unsafe { raw.data.keyboard };
                        let down = u32::from(k.Flags) & RI_KEY_BREAK == 0;
                        edges.key(&name, vk_key(k.VKey), down)
                    } else if raw.header.dwType == RIM_TYPEHID.0 {
                        // SAFETY: dwType says the union holds a HID record; the
                        // report bytes follow it inside `buf` (bounded by `got`).
                        let report = unsafe {
                            let hid = std::ptr::addr_of!(raw.data.hid);
                            let len = (*hid).dwSizeHid as usize;
                            let start = std::ptr::addr_of!((*hid).bRawData).cast::<u8>();
                            let offset = start.offset_from(buf.as_ptr().cast::<u8>()) as usize;
                            let len = len.min((got as usize).saturating_sub(offset));
                            std::slice::from_raw_parts(start, len).to_vec()
                        };
                        edges.report(&name, hid_key(&report))
                    } else {
                        vec![]
                    };
                    for (key, down) in out {
                        on_edge(app, inner, &mut pressed, &name, key, down);
                    }
                }
            }
        }
        // SAFETY: lets the system clean up the raw input buffer.
        unsafe { DispatchMessageW(&msg) };
    }
    Ok(())
}

#[cfg(not(windows))]
fn listen(_app: &AppHandle, _inner: &Mutex<Inner>) -> Result<(), String> {
    Err("selfie remote is Windows-only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> HidConfig {
        HidConfig {
            enabled: true,
            device: "dev-a".into(),
            bindings: vec![
                Binding {
                    key: "vk:26".into(),
                    action: Action::ZoomIn,
                },
                Binding {
                    key: "hid:02E900".into(),
                    action: Action::Photo,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn only_the_learned_device_moves_the_camera() {
        let c = cfg();
        assert_eq!(
            decide(&c, false, "dev-a", "vk:26"),
            Decision::Dispatch(Action::ZoomIn)
        );
        assert_eq!(decide(&c, false, "keyboard", "vk:26"), Decision::Ignore);
        assert_eq!(decide(&c, false, "dev-a", "vk:28"), Decision::Ignore);
        assert_eq!(decide(&c, true, "keyboard", "vk:41"), Decision::Learn);
        let off = HidConfig {
            enabled: false,
            ..cfg()
        };
        assert_eq!(decide(&off, false, "dev-a", "vk:26"), Decision::Ignore);
        let unlearned = HidConfig {
            device: String::new(),
            ..cfg()
        };
        assert_eq!(decide(&unlearned, false, "", "vk:26"), Decision::Ignore);
    }

    #[test]
    fn quick_taps_hold_for_the_minimum() {
        let t = Instant::now();
        assert_eq!(release_delay(None, t), Duration::ZERO);
        assert_eq!(
            release_delay(Some(t), t + Duration::from_millis(50)),
            Duration::from_millis(250)
        );
        assert_eq!(
            release_delay(Some(t), t + Duration::from_secs(2)),
            Duration::ZERO
        );
    }

    #[test]
    fn consumer_reports_become_keys() {
        assert_eq!(hid_key(&[0x02, 0xE9, 0x00]).as_deref(), Some("hid:02E900"));
        assert_eq!(hid_key(&[0x02, 0x00, 0x00]), None);
        assert_eq!(hid_key(&[]), None);
    }

    #[test]
    fn edges_drop_repeats_and_release_reports() {
        let mut e = Edges::default();
        assert_eq!(
            e.key("d", "vk:26".into(), true),
            vec![("vk:26".into(), true)]
        );
        assert!(e.key("d", "vk:26".into(), true).is_empty());
        assert_eq!(
            e.key("d", "vk:26".into(), false),
            vec![("vk:26".into(), false)]
        );
        assert!(e.key("d", "vk:26".into(), false).is_empty());

        assert_eq!(
            e.report("d", Some("hid:A".into())),
            vec![("hid:A".into(), true)]
        );
        assert!(e.report("d", Some("hid:A".into())).is_empty());
        assert_eq!(
            e.report("d", Some("hid:B".into())),
            vec![("hid:A".into(), false), ("hid:B".into(), true)]
        );
        assert_eq!(e.report("d", None), vec![("hid:B".into(), false)]);
        assert!(e.report("d", None).is_empty());
    }
}
