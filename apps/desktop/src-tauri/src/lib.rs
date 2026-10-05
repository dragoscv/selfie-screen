mod secrets;
mod sidecar;
mod tiktok;
mod windows_ext;

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use sidecar::{SidecarState, SidecarStatus};

/// Window-behaviour preferences the shell needs on the Rust side.
///
/// The renderer owns the settings file; it pushes the handful of values that
/// only native code can act on. Without this the close-to-tray toggle was
/// decorative — the window always hid.
#[derive(Debug, Clone)]
pub struct Behaviour {
    pub close_to_tray: bool,
    pub minimise_to_tray: bool,
    /// Last hotkey map pushed by the renderer, as registered.
    pub hotkeys: Hotkeys,
}

impl Default for Behaviour {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            minimise_to_tray: true,
            hotkeys: Hotkeys::default(),
        }
    }
}

#[derive(Default)]
pub struct BehaviourState(pub Mutex<Behaviour>);

/// Global hotkeys, named exactly like `settings.behaviour` so the renderer
/// can pass that object through unchanged (unknown keys are ignored).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub hotkey_toggle_overlay: String,
    pub hotkey_mute_voice: String,
    pub hotkey_push_to_talk: String,
    pub hotkey_pause_replies: String,
    pub hotkey_skip_reply: String,
    pub hotkey_effects_off: String,
    pub hotkey_highlight: String,
}

impl Hotkeys {
    /// Accelerator → action string emitted as the `hotkey` event payload.
    /// Actions match the Live Control vocabulary in `@tiksee/core` live.ts;
    /// toggles (mute) are resolved by the renderer, which owns the state.
    fn bindings(&self) -> [(&str, &'static str); 7] {
        [
            (self.hotkey_toggle_overlay.as_str(), "toggleOverlay"),
            (self.hotkey_mute_voice.as_str(), "muteAssistant"),
            (self.hotkey_push_to_talk.as_str(), "pushToTalk"),
            (self.hotkey_pause_replies.as_str(), "pauseReplies"),
            (self.hotkey_skip_reply.as_str(), "skipCurrent"),
            (self.hotkey_effects_off.as_str(), "effectsOff"),
            (self.hotkey_highlight.as_str(), "highlight"),
        ]
    }
}

/// Where the renderer should connect. Emitted again on demand because the
/// `sidecar://ready` event may fire before the webview finishes loading.
#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> SidecarStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn restart_sidecar(app: AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    state.spawn(&app)
}

/// Apply a Windows backdrop matching the chosen surface mode.
#[tauri::command]
fn set_surface(app: AppHandle, surface: String, dark: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;

    // The backdrop alone does not repaint the native frame: without also
    // setting the window theme, a light UI keeps a dark title bar and a
    // dark-tinted mica sheet.
    let theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    let _ = window.set_theme(Some(theme));
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_theme(Some(theme));
    }

    windows_ext::apply_backdrop(&window, &surface, dark)
}

/// Show/hide the always-on-top overlay window, creating it on first use.
#[tauri::command]
async fn toggle_overlay(app: AppHandle, show: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        if show {
            window.show().map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if !show {
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("TikSee overlay")
        .inner_size(360.0, 460.0)
        .min_inner_size(240.0, 200.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Let clicks pass through the overlay to whatever is behind it.
#[tauri::command]
fn set_overlay_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window is not open".to_string())?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

/// Push the window-behaviour preferences the shell has to enforce natively.
#[tauri::command]
fn set_behaviour(
    state: tauri::State<'_, BehaviourState>,
    close_to_tray: bool,
    minimise_to_tray: bool,
) -> Result<(), String> {
    let mut behaviour = state.0.lock().map_err(|e| e.to_string())?;
    behaviour.close_to_tray = close_to_tray;
    behaviour.minimise_to_tray = minimise_to_tray;
    Ok(())
}

/// Enable or disable launching TikSee when the user signs in.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();

    // Both calls are errors when the entry is already in the requested state
    // (disabling a non-existent registry entry reports "cannot find the file
    // specified"), so make this idempotent — it runs on every settings load.
    let current = manager.is_enabled().unwrap_or(false);
    if current == enabled {
        return Ok(());
    }

    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Re-register the global hotkeys.
///
/// Accelerators are re-registered wholesale rather than diffed: the set is
/// small, and unregister-all is the only way to drop a binding the user has
/// cleared. Pass `hotkeys` (the `settings.behaviour` object); the three flat
/// arguments are the older call shape and fill in only when it is absent.
///
/// Each press emits the `hotkey` event with the action string. A malformed
/// accelerator is logged and returned in the list; the rest still register.
#[tauri::command]
fn set_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, BehaviourState>,
    hotkeys: Option<Hotkeys>,
    toggle_overlay: Option<String>,
    mute_voice: Option<String>,
    push_to_talk: Option<String>,
) -> Result<Vec<String>, String> {
    let hotkeys = hotkeys.unwrap_or_else(|| Hotkeys {
        hotkey_toggle_overlay: toggle_overlay.unwrap_or_default(),
        hotkey_mute_voice: mute_voice.unwrap_or_default(),
        hotkey_push_to_talk: push_to_talk.unwrap_or_default(),
        ..Hotkeys::default()
    });
    let failures = register_hotkeys(&app, &hotkeys);
    state.0.lock().map_err(|e| e.to_string())?.hotkeys = hotkeys;
    Ok(failures)
}

#[cfg(desktop)]
fn register_hotkeys(app: &AppHandle, hotkeys: &Hotkeys) -> Vec<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();

    let mut failures: Vec<String> = Vec::new();
    for (accelerator, action) in hotkeys.bindings() {
        let accelerator = accelerator.trim();
        if accelerator.is_empty() {
            continue;
        }
        let handle = app.clone();
        let result = shortcuts.on_shortcut(accelerator, move |_app, _shortcut, event| {
            // Fire on press only; otherwise every hotkey triggers twice.
            if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            let _ = handle.emit("hotkey", action);
        });
        if let Err(error) = result {
            log::warn!("[hotkeys] {action} = '{accelerator}' not registered: {error}");
            failures.push(format!("{accelerator}: {error}"));
        }
    }
    failures
}

#[cfg(not(desktop))]
fn register_hotkeys(_app: &AppHandle, _hotkeys: &Hotkeys) -> Vec<String> {
    Vec::new()
}

/// Grant microphone and camera to TikSee's own windows so `getUserMedia`
/// works without a WebView2 prompt; every other window (the TikTok login
/// page) keeps the default behaviour.
fn permission_for(label: &str, kind: PermissionKind) -> PermissionResponse {
    let own_window = matches!(label, "main" | "overlay");
    match kind {
        PermissionKind::Microphone | PermissionKind::Camera if own_window => {
            PermissionResponse::Allow
        }
        _ => PermissionResponse::Default,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        );

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    let app = builder
        .manage(SidecarState::default())
        .manage(BehaviourState::default())
        .on_permission_request(|webview, kind| permission_for(webview.label(), kind))
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            restart_sidecar,
            set_surface,
            toggle_overlay,
            set_overlay_click_through,
            set_behaviour,
            set_autostart,
            set_hotkeys,
            tiktok::open_tiktok_login,
            tiktok::tiktok_session,
            tiktok::tiktok_session_clear,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            secrets::secret_has,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if let Some(window) = app.get_webview_window("main") {
                // Default to mica; the renderer re-applies the real preference
                // once settings load. Doing it here avoids a flash of an
                // opaque window on launch.
                let _ = windows_ext::apply_backdrop(&window, "mica", true);
                window.show()?;
            }

            build_tray(&handle)?;

            if let Some(state) = app.try_state::<SidecarState>()
                && let Err(error) = state.spawn(&handle)
            {
                // A missing sidecar must not prevent the UI from opening —
                // the renderer shows a recoverable error instead.
                log::error!("sidecar failed to start: {error}");
                state.status.lock().unwrap().error = Some(error);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let close_to_tray = window
                .app_handle()
                .try_state::<BehaviourState>()
                .and_then(|state| state.0.lock().ok().map(|b| b.close_to_tray))
                .unwrap_or(true);

            // Hiding to tray is a preference, not a law: with it off the
            // close button must actually exit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray {
                    let _ = window.hide();
                    api.prevent_close();
                } else {
                    if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                        state.kill();
                    }
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TikSee");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event
            && let Some(state) = handle.try_state::<SidecarState>()
        {
            state.kill();
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open TikSee", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "Toggle overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &overlay, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("TikSee")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main(app),
            "overlay" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let visible = handle
                        .get_webview_window("overlay")
                        .and_then(|w| w.is_visible().ok())
                        .unwrap_or(false);
                    let _ = toggle_overlay(handle, !visible).await;
                });
            }
            "quit" => {
                if let Some(state) = app.try_state::<SidecarState>() {
                    state.kill();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn reveal_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkeys_accept_the_settings_behaviour_object() {
        let hotkeys: Hotkeys = serde_json::from_str(
            r#"{"closeToTray":true,"hotkeyMuteVoice":"Ctrl+M","hotkeyHighlight":"Ctrl+H"}"#,
        )
        .unwrap();
        let bound: Vec<_> = hotkeys
            .bindings()
            .into_iter()
            .filter(|(accelerator, _)| !accelerator.is_empty())
            .collect();
        assert_eq!(
            bound,
            vec![("Ctrl+M", "muteAssistant"), ("Ctrl+H", "highlight")]
        );
    }

    #[test]
    fn media_permissions_only_for_own_windows() {
        assert!(matches!(
            permission_for("main", PermissionKind::Microphone),
            PermissionResponse::Allow
        ));
        assert!(matches!(
            permission_for("overlay", PermissionKind::Camera),
            PermissionResponse::Allow
        ));
        assert!(matches!(
            permission_for("tiktok-login", PermissionKind::Microphone),
            PermissionResponse::Default
        ));
        assert!(matches!(
            permission_for("main", PermissionKind::Geolocation),
            PermissionResponse::Default
        ));
    }
}
