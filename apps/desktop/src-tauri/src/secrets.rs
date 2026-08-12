/// Secret storage backed by the OS credential vault.
///
/// The Azure API key and the TikTok `sessionid` are full credentials. They
/// must never touch the settings JSON, the log file, or the renderer's
/// localStorage — on Windows they live in Credential Manager via DPAPI.
const SERVICE: &str = "ro.codai.tiksee";

#[cfg(windows)]
mod imp {
    use super::SERVICE;

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        if value.is_empty() {
            // Storing an empty secret is how the UI clears one.
            return match entry.delete_credential() {
                Ok(()) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            };
        }
        entry.set_password(value).map_err(|e| e.to_string())
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    // Non-Windows builds exist only so the crate compiles for tooling; the
    // product targets Windows. Fail loudly rather than storing plaintext.
    pub fn set(_key: &str, _value: &str) -> Result<(), String> {
        Err("Secret storage is only implemented on Windows".into())
    }
    pub fn get(_key: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_key: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Store a secret. An empty value deletes it.
#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    imp::set(&key, &value)
}

/// Read a secret. Returns `null` when absent.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    imp::get(&key)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    imp::delete(&key)
}

/// Whether a secret exists, without transporting its value to the renderer.
#[tauri::command]
pub fn secret_has(key: String) -> Result<bool, String> {
    Ok(imp::get(&key)?.is_some_and(|v| !v.is_empty()))
}
