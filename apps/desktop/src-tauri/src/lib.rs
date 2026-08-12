mod secrets;
mod sidecar;
mod windows_ext;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use sidecar::{SidecarState, SidecarStatus};

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

/// Open the TikTok login page in a dedicated window.
///
/// Tauri's WebView2 keeps cookies in the app's data directory, so the session
/// established here persists and is available to read afterwards.
#[tauri::command]
async fn open_tiktok_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tiktok-login") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = "https://www.tiktok.com/login"
        .parse()
        .map_err(|_| "invalid login URL".to_string())?;

    WebviewWindowBuilder::new(&app, "tiktok-login", WebviewUrl::External(url))
        .title("Sign in to TikTok")
        .inner_size(980.0, 760.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    let app = builder
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            restart_sidecar,
            set_surface,
            toggle_overlay,
            set_overlay_click_through,
            open_tiktok_login,
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

            if let Some(state) = app.try_state::<SidecarState>() {
                if let Err(error) = state.spawn(&handle) {
                    // A missing sidecar must not prevent the UI from opening —
                    // the renderer shows a recoverable error instead.
                    log::error!("sidecar failed to start: {error}");
                    state.status.lock().unwrap().error = Some(error);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the main window hides to tray; quitting happens from
                // the tray menu. Secondary windows just close.
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TikSee");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<SidecarState>() {
                state.kill();
            }
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
