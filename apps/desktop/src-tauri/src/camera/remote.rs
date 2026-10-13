//! One camera remote for every surface (HUD popover, detached window, selfie-stick
//! buttons): routes an action to the USB PC Remote session when TikSee holds one,
//! otherwise to the Bluetooth remote. Works without the Studio window.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::Control;
use super::ble::{BleAction, BleCtl};

/// Same names as `CAMERA_ACTIONS` in packages/core/src/vision.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    ZoomIn,
    ZoomOut,
    FocusNear,
    FocusFar,
    Af,
    Photo,
    Record,
}

impl Action {
    pub fn is_hold(self) -> bool {
        matches!(
            self,
            Self::ZoomIn | Self::ZoomOut | Self::FocusNear | Self::FocusFar
        )
    }
}

/// `auto` = USB when TikSee's USB session is connected, Bluetooth otherwise
/// (another app may own the USB port).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    #[default]
    Auto,
    Ble,
    Usb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
    Ble,
    Usb,
}

pub fn route(transport: Transport, usb_connected: bool) -> Result<Route, String> {
    match transport {
        Transport::Ble => Ok(Route::Ble),
        Transport::Usb if usb_connected => Ok(Route::Usb),
        Transport::Usb => Err("camera is not connected over USB".into()),
        Transport::Auto if usb_connected => Ok(Route::Usb),
        Transport::Auto => Ok(Route::Ble),
    }
}

/// Bluetooth command for a press (`down`) or release. `None` = nothing to send.
pub fn ble_command(action: Action, down: bool, speed: u8) -> Option<(BleAction, i32)> {
    let s = i32::from(speed.clamp(1, 3));
    let v = |dir: i32| if down { dir * s } else { 0 };
    match action {
        Action::ZoomIn => Some((BleAction::Zoom, v(1))),
        Action::ZoomOut => Some((BleAction::Zoom, v(-1))),
        Action::FocusNear => Some((BleAction::Focus, v(-1))),
        Action::FocusFar => Some((BleAction::Focus, v(1))),
        _ if !down => None,
        Action::Af => Some((BleAction::Af, 0)),
        Action::Photo => Some((BleAction::Photo, 0)),
        Action::Record => Some((BleAction::Record, 0)),
    }
}

/// One SDIO control write followed by a pause (ms) before the next one.
pub type UsbStep = (Control, i32, u64);

/// USB press sequence. Zoom holds/stops with the INT8 speed; focus holds are
/// repeated by the worker (`usb_focus_hold`); buttons are down/up pairs in the
/// same order as the Bluetooth remote (half before full, any other order wedges).
pub fn usb_steps(action: Action, down: bool, speed: u8) -> Vec<UsbStep> {
    let zoom = [2, 5, 8][usize::from(speed.clamp(1, 3) - 1)];
    match (action, down) {
        (Action::ZoomIn, true) => vec![(Control::Zoom, zoom, 0)],
        (Action::ZoomOut, true) => vec![(Control::Zoom, -zoom, 0)],
        (Action::ZoomIn | Action::ZoomOut, false) => vec![(Control::Zoom, 0, 0)],
        (Action::Af, true) => vec![(Control::HalfPress, 2, 500), (Control::HalfPress, 1, 0)],
        (Action::Photo, true) => vec![
            (Control::HalfPress, 2, 300),
            (Control::FullPress, 2, 120),
            (Control::FullPress, 1, 60),
            (Control::HalfPress, 1, 0),
        ],
        (Action::Record, true) => vec![(Control::Record, 2, 120), (Control::Record, 1, 0)],
        _ => vec![],
    }
}

/// Focus control repeated while a focus button is held over USB (`None` = stop).
pub fn usb_focus_hold(action: Action, down: bool, speed: u8) -> Option<Option<(Control, i32)>> {
    let steps = [1, 3, 7][usize::from(speed.clamp(1, 3) - 1)];
    match action {
        Action::FocusNear => Some(down.then_some((Control::FocusNear, steps))),
        Action::FocusFar => Some(down.then_some((Control::FocusFar, steps))),
        _ => None,
    }
}

/// Send one press/release through the chosen transport.
pub fn dispatch(
    app: &AppHandle,
    action: Action,
    down: bool,
    speed: u8,
    transport: Transport,
) -> Result<Route, String> {
    let usb = app.try_state::<super::CameraCtl>();
    let connected = usb.as_ref().is_some_and(|c| c.usb_connected());
    let chosen = route(transport, connected)?;
    match chosen {
        Route::Usb => {
            let usb = usb.ok_or("camera control is not running")?;
            usb.press(action, down, speed)?;
        }
        Route::Ble => {
            if let Some((a, v)) = ble_command(action, down, speed) {
                app.try_state::<BleCtl>()
                    .ok_or("bluetooth remote is not running")?
                    .send(a, v)?;
            }
        }
    }
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_prefers_usb_only_when_connected() {
        assert_eq!(route(Transport::Auto, true), Ok(Route::Usb));
        assert_eq!(route(Transport::Auto, false), Ok(Route::Ble));
        assert_eq!(route(Transport::Ble, true), Ok(Route::Ble));
        assert!(route(Transport::Usb, false).is_err());
    }

    #[test]
    fn ble_holds_release_and_one_shots_fire_on_press() {
        assert_eq!(
            ble_command(Action::ZoomIn, true, 2),
            Some((BleAction::Zoom, 2))
        );
        assert_eq!(
            ble_command(Action::ZoomOut, true, 9),
            Some((BleAction::Zoom, -3))
        );
        assert_eq!(
            ble_command(Action::FocusNear, false, 1),
            Some((BleAction::Focus, 0))
        );
        assert_eq!(
            ble_command(Action::Photo, true, 1),
            Some((BleAction::Photo, 0))
        );
        assert_eq!(ble_command(Action::Photo, false, 1), None);
    }

    #[test]
    fn usb_sequences() {
        assert_eq!(
            usb_steps(Action::ZoomOut, true, 3),
            vec![(Control::Zoom, -8, 0)]
        );
        assert_eq!(
            usb_steps(Action::ZoomIn, false, 1),
            vec![(Control::Zoom, 0, 0)]
        );
        assert_eq!(usb_steps(Action::Record, false, 1), vec![]);
        let photo: Vec<_> = usb_steps(Action::Photo, true, 1)
            .into_iter()
            .map(|(c, v, _)| (c, v))
            .collect();
        assert_eq!(
            photo,
            vec![
                (Control::HalfPress, 2),
                (Control::FullPress, 2),
                (Control::FullPress, 1),
                (Control::HalfPress, 1)
            ]
        );
        assert_eq!(
            usb_focus_hold(Action::FocusFar, true, 2),
            Some(Some((Control::FocusFar, 3)))
        );
        assert_eq!(usb_focus_hold(Action::FocusNear, false, 2), Some(None));
        assert_eq!(usb_focus_hold(Action::Af, true, 2), None);
    }
}
