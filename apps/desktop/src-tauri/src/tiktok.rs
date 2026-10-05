//! TikTok session harvesting from the login window.
//!
//! The user signs in inside a dedicated WebView2 window; once TikTok sets the
//! `sessionid` cookie we copy it (plus `tt-target-idc`, the data-centre hint
//! the webcast connector needs) into Credential Manager and close the window.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::Url;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::secrets;

pub const LOGIN_WINDOW: &str = "tiktok-login";
const LOGIN_URL: &str = "https://www.tiktok.com/login";
const COOKIE_URL: &str = "https://www.tiktok.com/";
const POLL_EVERY: Duration = Duration::from_secs(2);
const SESSION_EVENT: &str = "tiktok://session";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TikTokSession {
    pub session_id: String,
    pub tt_target_idc: String,
}

/// Open the TikTok login page and start watching it for a session cookie.
#[tauri::command]
pub async fn open_tiktok_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = LOGIN_URL
        .parse()
        .map_err(|_| "invalid login URL".to_string())?;

    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Sign in to TikTok")
        .inner_size(980.0, 760.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn(watch_login(app));
    Ok(())
}

/// The stored session, if any.
#[tauri::command]
pub fn tiktok_session() -> Result<Option<TikTokSession>, String> {
    load()
}

/// Forget the stored session.
#[tauri::command]
pub fn tiktok_session_clear(app: AppHandle) -> Result<(), String> {
    secrets::remove(secrets::TIKTOK_SESSION)?;
    let _ = app.emit(SESSION_EVENT, Option::<TikTokSession>::None);
    log::info!("[tiktok] session cleared");
    Ok(())
}

fn load() -> Result<Option<TikTokSession>, String> {
    let Some(raw) = secrets::read(secrets::TIKTOK_SESSION)? else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

/// Poll the login window's cookie jar until a session appears or the user
/// closes the window.
async fn watch_login(app: AppHandle) {
    let url: Url = match COOKIE_URL.parse() {
        Ok(url) => url,
        Err(_) => return,
    };
    loop {
        tokio::time::sleep(POLL_EVERY).await;
        let Some(window) = app.get_webview_window(LOGIN_WINDOW) else {
            return;
        };

        // WebView2 deadlocks when cookies are read on the event-loop thread
        // or inside a synchronous handler; read them on a blocking worker.
        let cookie_url = url.clone();
        let cookies =
            tauri::async_runtime::spawn_blocking(move || window.cookies_for_url(cookie_url)).await;
        let cookies = match cookies {
            Ok(Ok(cookies)) => cookies,
            Ok(Err(error)) => {
                log::warn!("[tiktok] reading cookies failed: {error}");
                continue;
            }
            Err(_) => continue,
        };

        let pairs = cookies
            .iter()
            .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()));
        let Some(session) = session_from_cookies(pairs) else {
            continue;
        };

        match serde_json::to_string(&session)
            .map_err(|e| e.to_string())
            .and_then(|json| secrets::write(secrets::TIKTOK_SESSION, &json))
        {
            Ok(()) => log::info!("[tiktok] session captured"),
            Err(error) => {
                log::error!("[tiktok] storing session failed: {error}");
                return;
            }
        }
        let _ = app.emit(SESSION_EVENT, Some(session));
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = window.close();
        }
        return;
    }
}

fn session_from_cookies(pairs: impl Iterator<Item = (String, String)>) -> Option<TikTokSession> {
    let mut session_id = None;
    let mut idc = String::new();
    for (name, value) in pairs {
        match name.as_str() {
            "sessionid" if !value.is_empty() => session_id = Some(value),
            "tt-target-idc" => idc = value,
            _ => {}
        }
    }
    session_id.map(|session_id| TikTokSession {
        session_id,
        tt_target_idc: idc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> impl Iterator<Item = (String, String)> {
        list.iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn no_session_until_sessionid_is_set() {
        assert_eq!(session_from_cookies(pairs(&[("ttwid", "x")])), None);
        assert_eq!(session_from_cookies(pairs(&[("sessionid", "")])), None);
    }

    #[test]
    fn captures_session_and_idc() {
        let session = session_from_cookies(pairs(&[
            ("tt-target-idc", "useast2a"),
            ("sessionid", "abc"),
        ]))
        .unwrap();
        assert_eq!(session.session_id, "abc");
        assert_eq!(session.tt_target_idc, "useast2a");
    }

    #[test]
    fn serialises_camel_case() {
        let json = serde_json::to_string(&TikTokSession {
            session_id: "a".into(),
            tt_target_idc: "b".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"sessionId":"a","ttTargetIdc":"b"}"#);
    }
}
