//! Sony Bluetooth remote (the RMT-P1BT protocol): zoom, focus, AF, photo and
//! record over BLE. Unlike the USB SDIO session, it leaves the camera's HDMI
//! output untouched, so it is the transport used while live (verified on
//! ZV-E10 fw 2.02). One worker thread owns the GATT link; commands go through
//! a channel and state is emitted as `camera://ble`.

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Sony's Bluetooth SIG company id, little-endian in advertisements.
pub const SONY_COMPANY_ID: u16 = 0x012D;
/// Tag 0x22 flag: the camera is accepting a new pairing.
const PAIRING_OPEN: u8 = 0x40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BleAction {
    /// value: -1 wide, +1 tele, 0 stop. |value| 1..=3 picks the speed.
    Zoom,
    /// value: -1 near, +1 far, 0 stop. |value| 1..=3 picks the speed.
    Focus,
    /// Half press then release: autofocus once.
    Af,
    /// Full shutter sequence.
    Photo,
    /// Movie record button (toggles recording).
    Record,
    /// Pair with a camera that shows "Pairing" (Bluetooth Rmt Ctrl on).
    Pair,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BleState {
    /// "searching" | "pairable" | "connected" | "error"
    pub status: String,
    pub address: Option<String>,
    pub recording: bool,
    pub focused: bool,
    pub error: Option<String>,
}

/// Bytes written to FF01 for one step of an action. `None` = nothing to send.
pub fn press(action: BleAction, value: i32) -> Vec<Vec<u8>> {
    let speed = |base: u8, max: u8| -> u8 {
        let n = value.unsigned_abs().clamp(1, 3) as u8;
        (base + (max - base) * (n - 1) / 2).max(base)
    };
    match (action, value.signum()) {
        (BleAction::Zoom, 1) => vec![vec![0x02, 0x45, speed(0x20, 0x8f)]],
        (BleAction::Zoom, -1) => vec![vec![0x02, 0x47, speed(0x20, 0x8f)]],
        (BleAction::Focus, -1) => vec![vec![0x02, 0x6b, speed(0x10, 0x7f)]],
        (BleAction::Focus, 1) => vec![vec![0x02, 0x6d, speed(0x10, 0x7f)]],
        (BleAction::Af, _) => vec![vec![0x01, 0x07], vec![0x01, 0x06]],
        // Half down, full down, half up, full up: any other order wedges the camera.
        (BleAction::Photo, _) => vec![
            vec![0x01, 0x07],
            vec![0x01, 0x09],
            vec![0x01, 0x06],
            vec![0x01, 0x08],
        ],
        (BleAction::Record, _) => vec![vec![0x01, 0x0f], vec![0x01, 0x0e]],
        _ => vec![],
    }
}

/// Release for the last held zoom/focus direction.
pub fn release(action: BleAction, last_dir: i32) -> Option<Vec<u8>> {
    match (action, last_dir) {
        (BleAction::Zoom, 1) => Some(vec![0x02, 0x44, 0x00]),
        (BleAction::Zoom, -1) => Some(vec![0x02, 0x46, 0x00]),
        (BleAction::Focus, -1) => Some(vec![0x02, 0x6a, 0x00]),
        (BleAction::Focus, 1) => Some(vec![0x02, 0x6c, 0x00]),
        _ => None,
    }
}

/// Tag 0x22 value from Sony manufacturer data (after the company id).
pub fn status_flags(data: &[u8]) -> Option<u8> {
    // Header: 03 00 (camera) 64 (proto) 00 xx xx (model), then <tag><val><00>.
    let mut i = 6;
    while i + 1 < data.len() {
        if data[i] == 0x22 {
            return Some(data[i + 1]);
        }
        i += 3;
    }
    None
}

/// Apply a FF02 notification to the state. Returns true when it changed.
pub fn apply_notify(state: &mut BleState, n: &[u8]) -> bool {
    let before = (state.recording, state.focused);
    match n {
        [0x02, 0x3f, v] => state.focused = *v == 0x20,
        [0x02, 0xd5, v] => state.recording = *v == 0x20,
        _ => {}
    }
    before != (state.recording, state.focused)
}

enum Req {
    Act(BleAction, i32),
    Shutdown,
}

#[derive(Default)]
pub struct BleCtl {
    tx: Mutex<Option<Sender<Req>>>,
}

impl BleCtl {
    pub fn start(&self, app: &AppHandle) {
        let Ok(mut guard) = self.tx.lock() else {
            return;
        };
        if guard.is_some() {
            return;
        }
        let (tx, rx) = channel();
        *guard = Some(tx);
        let app = app.clone();
        std::thread::Builder::new()
            .name("camera-ble".into())
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

    pub fn send(&self, action: BleAction, value: i32) -> Result<(), String> {
        let g = self.tx.lock().map_err(|e| e.to_string())?;
        g.as_ref()
            .ok_or("bluetooth remote is not running")?
            .send(Req::Act(action, value))
            .map_err(|e| e.to_string())
    }
}

fn emit(app: &AppHandle, s: &BleState) {
    let _ = app.emit("camera://ble", s);
}

#[cfg(windows)]
fn worker(app: AppHandle, rx: Receiver<Req>) {
    use link::Link;
    let mut state = BleState {
        status: "searching".into(),
        ..Default::default()
    };
    emit(&app, &state);
    let mut link: Option<Link> = None;
    let mut pair_requested = false;
    let mut held: [(BleAction, i32); 2] = [(BleAction::Zoom, 0), (BleAction::Focus, 0)];
    loop {
        if link.as_ref().is_some_and(|l| !l.alive()) {
            log::info!("[camera] bluetooth link dropped");
            link = None;
        }
        if link.is_none() {
            let next = match link::find() {
                Ok(Some(found)) if found.paired || (pair_requested && found.pairable) => {
                    match Link::open(found.address, !found.paired) {
                        Ok(l) => {
                            pair_requested = false;
                            log::info!("[camera] bluetooth remote connected {}", l.label());
                            let s = BleState {
                                status: "connected".into(),
                                address: Some(l.label()),
                                ..Default::default()
                            };
                            link = Some(l);
                            s
                        }
                        Err(e) => BleState {
                            status: "error".into(),
                            error: Some(e),
                            ..Default::default()
                        },
                    }
                }
                Ok(Some(found)) => BleState {
                    status: if found.pairable {
                        "pairable"
                    } else {
                        "searching"
                    }
                    .into(),
                    address: Some(link::label(found.address)),
                    error: (!found.pairable).then(|| "not paired".to_string()),
                    ..Default::default()
                },
                Ok(None) => BleState {
                    status: "searching".into(),
                    ..Default::default()
                },
                Err(e) => BleState {
                    status: "error".into(),
                    error: Some(e),
                    ..Default::default()
                },
            };
            if next != state {
                state = next;
                emit(&app, &state);
            }
        }
        if let Some(l) = link.as_ref() {
            let mut changed = false;
            while let Some(n) = l.notification() {
                changed |= apply_notify(&mut state, &n);
            }
            if changed {
                emit(&app, &state);
            }
        }
        let wait = if link.is_some() {
            Duration::from_millis(100)
        } else {
            Duration::from_secs(2)
        };
        match rx.recv_timeout(wait) {
            Ok(Req::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                if let Some(l) = link.as_ref() {
                    for (a, d) in held {
                        if let Some(r) = release(a, d) {
                            let _ = l.write(&r);
                        }
                    }
                }
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Ok(Req::Act(BleAction::Pair, _)) => pair_requested = true,
            Ok(Req::Act(action, value)) => {
                let Some(l) = link.as_ref() else {
                    state.error = Some("camera not connected over Bluetooth".into());
                    emit(&app, &state);
                    continue;
                };
                let slot = usize::from(action == BleAction::Focus);
                let mut writes = Vec::new();
                if matches!(action, BleAction::Zoom | BleAction::Focus) {
                    let (_, last) = held[slot];
                    if last != 0 && last != value.signum() {
                        writes.extend(release(action, last));
                    }
                    held[slot] = (action, value.signum());
                }
                writes.extend(press(action, value));
                for w in writes {
                    if let Err(e) = l.write(&w) {
                        log::warn!("[camera] bluetooth write failed: {e}");
                        state.error = Some(e);
                        emit(&app, &state);
                        link = None;
                        break;
                    }
                    if matches!(action, BleAction::Photo | BleAction::Af | BleAction::Record) {
                        std::thread::sleep(Duration::from_millis(80));
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn worker(app: AppHandle, _rx: Receiver<Req>) {
    emit(
        &app,
        &BleState {
            status: "error".into(),
            error: Some("bluetooth remote is Windows-only".into()),
            ..Default::default()
        },
    );
}

#[cfg(windows)]
mod link {
    use std::sync::mpsc::{Receiver, channel};
    use std::time::{Duration, Instant};

    use windows::Devices::Bluetooth::Advertisement::{
        BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher,
        BluetoothLEScanningMode,
    };
    use windows::Devices::Bluetooth::GenericAttributeProfile::{
        GattCharacteristic, GattCharacteristicProperties,
        GattClientCharacteristicConfigurationDescriptorValue, GattCommunicationStatus,
        GattValueChangedEventArgs, GattWriteOption,
    };
    use windows::Devices::Bluetooth::{
        BluetoothCacheMode, BluetoothConnectionStatus, BluetoothLEDevice,
    };
    use windows::Devices::Enumeration::{
        DevicePairingKinds, DevicePairingProtectionLevel, DevicePairingRequestedEventArgs,
        DevicePairingResultStatus,
    };
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};
    use windows::core::{GUID, Ref};

    use super::{PAIRING_OPEN, SONY_COMPANY_ID, status_flags};

    const REMOTE_SERVICE: GUID = GUID::from_u128(0x8000ff00_ff00_ffff_ffff_ffffffffffff);
    const REMOTE_COMMAND: GUID = GUID::from_u128(0x0000ff01_0000_1000_8000_00805f9b34fb);
    const REMOTE_NOTIFY: GUID = GUID::from_u128(0x0000ff02_0000_1000_8000_00805f9b34fb);

    pub struct Found {
        pub address: u64,
        pub paired: bool,
        pub pairable: bool,
    }

    pub fn label(address: u64) -> String {
        let b = address.to_be_bytes();
        b[2..]
            .iter()
            .map(|x| format!("{x:02X}"))
            .collect::<Vec<_>>()
            .join(":")
    }

    fn bytes(buf: &IBuffer) -> windows::core::Result<Vec<u8>> {
        let r = DataReader::FromBuffer(buf)?;
        let mut v = vec![0u8; buf.Length()? as usize];
        r.ReadBytes(&mut v)?;
        Ok(v)
    }

    /// Scan ~4 s for a Sony camera advertisement; prefer one already paired.
    pub fn find() -> Result<Option<Found>, String> {
        let e = |e: windows::core::Error| format!("bluetooth: {}", e.message());
        let watcher = BluetoothLEAdvertisementWatcher::new().map_err(e)?;
        watcher
            .SetScanningMode(BluetoothLEScanningMode::Active)
            .map_err(e)?;
        let (tx, rx) = channel::<(u64, u8)>();
        watcher
            .Received(&TypedEventHandler::new(
                move |_, args: Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
                    let Some(args) = args.as_ref() else {
                        return Ok(());
                    };
                    for m in args.Advertisement()?.ManufacturerData()? {
                        if m.CompanyId()? == SONY_COMPANY_ID {
                            let data = bytes(&m.Data()?)?;
                            if data.starts_with(&[0x03, 0x00]) {
                                let _ = tx.send((
                                    args.BluetoothAddress()?,
                                    status_flags(&data).unwrap_or(0),
                                ));
                            }
                        }
                    }
                    Ok(())
                },
            ))
            .map_err(e)?;
        watcher.Start().map_err(e)?;
        let end = Instant::now() + Duration::from_secs(4);
        let mut best: Option<Found> = None;
        while Instant::now() < end {
            let Ok((address, flags)) = rx.recv_timeout(Duration::from_millis(200)) else {
                continue;
            };
            if best.as_ref().is_some_and(|b| b.address == address) {
                continue;
            }
            let paired = BluetoothLEDevice::FromBluetoothAddressAsync(address)
                .and_then(|op| op.join())
                .and_then(|d| d.DeviceInformation()?.Pairing()?.IsPaired())
                .unwrap_or(false);
            let found = Found {
                address,
                paired,
                pairable: flags & PAIRING_OPEN != 0,
            };
            if paired {
                best = Some(found);
                break;
            }
            best.get_or_insert(found);
        }
        let _ = watcher.Stop();
        Ok(best)
    }

    pub struct Link {
        device: BluetoothLEDevice,
        command: GattCharacteristic,
        notes: Receiver<Vec<u8>>,
        _notify: Option<GattCharacteristic>,
    }

    impl Link {
        pub fn open(address: u64, pair: bool) -> Result<Self, String> {
            let e = |e: windows::core::Error| format!("bluetooth: {}", e.message());
            let device = BluetoothLEDevice::FromBluetoothAddressAsync(address)
                .and_then(|op| op.join())
                .map_err(e)?;
            if pair {
                let custom = device
                    .DeviceInformation()
                    .and_then(|i| i.Pairing()?.Custom())
                    .map_err(e)?;
                custom
                    .PairingRequested(&TypedEventHandler::new(
                        |_, args: Ref<DevicePairingRequestedEventArgs>| {
                            if let Some(a) = args.as_ref() {
                                a.Accept()?;
                            }
                            Ok(())
                        },
                    ))
                    .map_err(e)?;
                let result = custom
                    .PairWithProtectionLevelAsync(
                        DevicePairingKinds::ConfirmOnly | DevicePairingKinds::ConfirmPinMatch,
                        DevicePairingProtectionLevel::Encryption,
                    )
                    .and_then(|op| op.join())
                    .and_then(|r| r.Status())
                    .map_err(e)?;
                if result != DevicePairingResultStatus::Paired
                    && result != DevicePairingResultStatus::AlreadyPaired
                {
                    return Err(format!("pairing failed ({})", result.0));
                }
            }
            let services = device
                .GetGattServicesForUuidWithCacheModeAsync(
                    REMOTE_SERVICE,
                    BluetoothCacheMode::Uncached,
                )
                .and_then(|op| op.join())
                .map_err(e)?;
            if services.Status().map_err(e)? != GattCommunicationStatus::Success {
                return Err("camera did not answer (is Bluetooth Rmt Ctrl on?)".into());
            }
            let service = services
                .Services()
                .and_then(|s| s.GetAt(0))
                .map_err(|_| "remote service missing: turn on Bluetooth Rmt Ctrl".to_string())?;
            let characteristic = |uuid: GUID| {
                service
                    .GetCharacteristicsForUuidWithCacheModeAsync(uuid, BluetoothCacheMode::Uncached)
                    .and_then(|op| op.join())
                    .and_then(|r| r.Characteristics()?.GetAt(0))
            };
            let command = characteristic(REMOTE_COMMAND).map_err(e)?;
            let (tx, notes) = channel();
            let notify = characteristic(REMOTE_NOTIFY).ok().filter(|c| {
                c.CharacteristicProperties()
                    .is_ok_and(|p| p.contains(GattCharacteristicProperties::Notify))
            });
            if let Some(c) = notify.as_ref() {
                let _ = c.ValueChanged(&TypedEventHandler::new(
                    move |_, args: Ref<GattValueChangedEventArgs>| {
                        if let Some(a) = args.as_ref() {
                            let _ = tx.send(bytes(&a.CharacteristicValue()?)?);
                        }
                        Ok(())
                    },
                ));
                let _ = c
                    .WriteClientCharacteristicConfigurationDescriptorAsync(
                        GattClientCharacteristicConfigurationDescriptorValue::Notify,
                    )
                    .and_then(|op| op.join());
            }
            Ok(Self {
                device,
                command,
                notes,
                _notify: notify,
            })
        }

        pub fn label(&self) -> String {
            self.device
                .BluetoothAddress()
                .map(label)
                .unwrap_or_default()
        }

        pub fn alive(&self) -> bool {
            self.device
                .ConnectionStatus()
                .is_ok_and(|s| s == BluetoothConnectionStatus::Connected)
        }

        pub fn notification(&self) -> Option<Vec<u8>> {
            self.notes.try_recv().ok()
        }

        pub fn write(&self, data: &[u8]) -> Result<(), String> {
            let e = |e: windows::core::Error| format!("bluetooth: {}", e.message());
            let w = DataWriter::new().map_err(e)?;
            w.WriteBytes(data).map_err(e)?;
            let status = self
                .command
                .WriteValueWithOptionAsync(
                    &w.DetachBuffer().map_err(e)?,
                    GattWriteOption::WriteWithResponse,
                )
                .and_then(|op| op.join())
                .map_err(e)?;
            if status == GattCommunicationStatus::Success {
                Ok(())
            } else {
                Err(format!("bluetooth write status {}", status.0))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_and_focus_use_direction_and_speed() {
        assert_eq!(press(BleAction::Zoom, 1), vec![vec![0x02, 0x45, 0x20]]);
        assert_eq!(press(BleAction::Zoom, -3), vec![vec![0x02, 0x47, 0x8f]]);
        assert_eq!(press(BleAction::Focus, -1), vec![vec![0x02, 0x6b, 0x10]]);
        assert_eq!(press(BleAction::Focus, 3), vec![vec![0x02, 0x6d, 0x7f]]);
        assert!(press(BleAction::Zoom, 0).is_empty());
        assert_eq!(release(BleAction::Zoom, 1), Some(vec![0x02, 0x44, 0x00]));
        assert_eq!(release(BleAction::Focus, 1), Some(vec![0x02, 0x6c, 0x00]));
        assert_eq!(release(BleAction::Zoom, 0), None);
    }

    #[test]
    fn photo_follows_the_only_safe_shutter_order() {
        assert_eq!(
            press(BleAction::Photo, 0),
            vec![vec![1, 7], vec![1, 9], vec![1, 6], vec![1, 8]]
        );
    }

    #[test]
    fn advert_flags_and_notifications_decode() {
        // Real ZV-E10 advert (pairing open), company id stripped.
        let adv = [
            0x03, 0x00, 0x64, 0x00, 0x45, 0x31, 0x22, 0xef, 0x00, 0x21, 0x60, 0x00,
        ];
        assert_eq!(status_flags(&adv), Some(0xef));
        assert_eq!(
            status_flags(&adv).map(|f| f & PAIRING_OPEN != 0),
            Some(true)
        );
        let closed = [0x03, 0x00, 0x64, 0x00, 0x45, 0x31, 0x22, 0xaf, 0x00];
        assert_eq!(
            status_flags(&closed).map(|f| f & PAIRING_OPEN != 0),
            Some(false)
        );

        let mut s = BleState::default();
        assert!(apply_notify(&mut s, &[0x02, 0xd5, 0x20]));
        assert!(s.recording);
        assert!(!apply_notify(&mut s, &[0x02, 0xa0, 0x20]));
        assert!(apply_notify(&mut s, &[0x02, 0x3f, 0x20]));
        assert!(s.focused);
    }
}
