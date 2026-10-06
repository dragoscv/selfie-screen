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

/// Keep the studio window's CLIENT area at `num:den` while the user drags any
/// edge or corner, so the preview never letterboxes (owner request 2026-10-06).
/// Done in WM_SIZING, which edits the drag rectangle live: no snap-back flicker.
#[cfg(windows)]
pub fn lock_aspect(window: &WebviewWindow, num: u32, den: u32) -> Result<(), String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        AdjustWindowRectEx, GWL_EXSTYLE, GWL_STYLE, GetWindowLongW, WINDOW_EX_STYLE, WINDOW_STYLE,
        WM_SIZING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP,
        WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };

    /// Packed `num << 16 | den`, read by the subclass proc (one studio window).
    static RATIO: AtomicU32 = AtomicU32::new(0);
    const SUBCLASS_ID: usize = 0x7153_5644;

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_SIZING {
            let packed = RATIO.load(Ordering::Relaxed);
            let (num, den) = ((packed >> 16) as i32, (packed & 0xffff) as i32);
            // SAFETY: for WM_SIZING, lparam points to the drag RECT owned by the caller.
            let rect = unsafe { &mut *(lparam.0 as *mut RECT) };
            if num > 0 && den > 0 {
                // Frame size = window rect minus client rect for this style.
                let mut frame = RECT::default();
                // SAFETY: plain style queries on our own window.
                let (style, ex) = unsafe {
                    (
                        WINDOW_STYLE(GetWindowLongW(hwnd, GWL_STYLE) as u32),
                        WINDOW_EX_STYLE(GetWindowLongW(hwnd, GWL_EXSTYLE) as u32),
                    )
                };
                // SAFETY: frame is a valid out-RECT.
                let _ = unsafe { AdjustWindowRectEx(&mut frame, style, false, ex) };
                let fw = frame.right - frame.left;
                let fh = frame.bottom - frame.top;
                let cw = (rect.right - rect.left - fw).max(1);
                let ch = (rect.bottom - rect.top - fh).max(1);
                let edge = wparam.0 as u32;
                let horizontal_drag = edge == WMSZ_LEFT || edge == WMSZ_RIGHT;
                let vertical_drag = edge == WMSZ_TOP || edge == WMSZ_BOTTOM;
                // Side edges drive width; top/bottom drive height; corners follow the larger change.
                let (w, h) = if horizontal_drag || (!vertical_drag && cw * den >= ch * num) {
                    (cw, cw * den / num)
                } else {
                    (ch * num / den, ch)
                };
                let (ww, wh) = (w + fw, h + fh);
                if edge == WMSZ_LEFT || edge == WMSZ_TOPLEFT || edge == WMSZ_BOTTOMLEFT {
                    rect.left = rect.right - ww;
                } else {
                    rect.right = rect.left + ww;
                }
                if edge == WMSZ_TOP || edge == WMSZ_TOPLEFT || edge == WMSZ_TOPRIGHT {
                    rect.top = rect.bottom - wh;
                } else if edge == WMSZ_BOTTOM
                    || edge == WMSZ_BOTTOMLEFT
                    || edge == WMSZ_BOTTOMRIGHT
                    || horizontal_drag
                {
                    rect.bottom = rect.top + wh;
                }
                return LRESULT(1);
            }
        }
        // SAFETY: forwarding to the next handler in the subclass chain.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    RATIO.store((num.min(0xffff) << 16) | den.min(0xffff), Ordering::Relaxed);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: hwnd belongs to this process; the proc is a static function.
    let ok = unsafe { SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0) };
    if ok.as_bool() {
        Ok(())
    } else {
        Err("SetWindowSubclass failed".into())
    }
}

#[cfg(not(windows))]
pub fn lock_aspect(_window: &WebviewWindow, _num: u32, _den: u32) -> Result<(), String> {
    Ok(())
}
