use tauri::WebviewWindow;

/// Apply the native Windows 11 backdrop that matches a surface mode.
///
/// `mica` and `acrylic` make the window itself translucent, which is why the
/// CSS sets `--app-bg: transparent` for those modes — the OS paints behind the
/// webview. `solid` and `contrast` clear the effect so the page background is
/// authoritative again.
#[cfg(windows)]
pub fn apply_backdrop(window: &WebviewWindow, surface: &str, dark: bool) -> Result<(), String> {
    use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};

    // Clear both first: switching modes must not leave the previous effect
    // stacked underneath the new one.
    let _ = clear_mica(window);
    let _ = clear_acrylic(window);

    match surface {
        "mica" => apply_mica(window, Some(dark)).map_err(|e| e.to_string()),
        "glass" => apply_acrylic(window, Some(acrylic_tint(dark))).map_err(|e| e.to_string()),
        // solid / contrast: no OS effect, the page paints its own background.
        _ => Ok(()),
    }
}

/// Acrylic needs an explicit RGBA tint; mica derives its own from the wallpaper.
#[cfg(windows)]
fn acrylic_tint(dark: bool) -> (u8, u8, u8, u8) {
    if dark {
        (16, 18, 26, 148)
    } else {
        (246, 247, 250, 148)
    }
}

#[cfg(not(windows))]
pub fn apply_backdrop(_window: &WebviewWindow, _surface: &str, _dark: bool) -> Result<(), String> {
    // Backdrops are a Windows feature; elsewhere the CSS surface styles alone
    // produce a reasonable approximation.
    Ok(())
}
