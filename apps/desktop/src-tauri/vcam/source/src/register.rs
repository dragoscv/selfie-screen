//! COM self-registration (`DllRegisterServer` / `DllUnregisterServer`).
//!
//! Writes `HKLM\Software\Classes\CLSID\{...}` with the description and
//! `InprocServer32` = this DLL's full path, `ThreadingModel=Both`.

use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, HMODULE, WIN32_ERROR};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW,
    RegSetValueExW,
};
use windows_core::{HSTRING, PCWSTR, Result};

use tiksee_vcam_shared::layout::{SOURCE_DESCRIPTION, clsid_key};

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: opened by RegCreateKeyExW.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn create_key(path: &str) -> Result<Key> {
    let mut key = HKEY::default();
    // SAFETY: valid out pointer; path is NUL-terminated by HSTRING.
    unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(path),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
        .ok()?;
    }
    Ok(Key(key))
}

/// UTF-16 with the terminating NUL, as bytes (what REG_SZ expects).
pub(crate) fn reg_sz(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn set_string(key: &Key, name: Option<&str>, value: &str) -> Result<()> {
    let name = name.map(HSTRING::from);
    let name_ptr = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    // SAFETY: key is open for writing; data outlives the call.
    unsafe { RegSetValueExW(key.0, name_ptr, None, REG_SZ, Some(&reg_sz(value))).ok() }
}

pub(crate) fn module_path(module: HMODULE) -> Result<String> {
    let mut buffer = vec![0u16; 1024];
    loop {
        // SAFETY: buffer is writable for its length.
        let len = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
        if len == 0 {
            return Err(windows_core::Error::from_thread());
        }
        if len < buffer.len() {
            return Ok(String::from_utf16_lossy(&buffer[..len]));
        }
        buffer.resize(buffer.len() * 2, 0);
    }
}

pub(crate) fn register(module: HMODULE) -> Result<()> {
    let path = module_path(module)?;
    let root = clsid_key();
    let clsid = create_key(&root)?;
    set_string(&clsid, None, SOURCE_DESCRIPTION)?;
    let server = create_key(&format!("{root}\\InprocServer32"))?;
    set_string(&server, None, &path)?;
    set_string(&server, Some("ThreadingModel"), "Both")?;
    vlog!("registered {path}");
    Ok(())
}

pub(crate) fn unregister() -> Result<()> {
    // SAFETY: plain registry call.
    let status: WIN32_ERROR = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, &HSTRING::from(clsid_key())) };
    if status != ERROR_FILE_NOT_FOUND {
        status.ok()?;
    }
    vlog!("unregistered");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg_sz_is_nul_terminated_utf16le() {
        assert_eq!(reg_sz("Ab"), vec![b'A', 0, b'b', 0, 0, 0]);
        assert_eq!(reg_sz(""), vec![0, 0]);
    }
}
