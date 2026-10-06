//! Small COM / Media Foundation helpers.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard, PoisonError};

use windows::Win32::Foundation::{E_UNEXPECTED, ERROR_SET_NOT_FOUND};
use windows::Win32::Media::MediaFoundation::{IMFAttributes, MFCreateAttributes};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Variant::VT_I8;
use windows_core::{Error, HRESULT, Result};

/// `HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND)` = 0x80070492.
pub(crate) fn set_not_found() -> Error {
    HRESULT::from_win32(ERROR_SET_NOT_FOUND.0).into()
}

pub(crate) fn new_attributes(initial: u32) -> Result<IMFAttributes> {
    let mut attributes = None;
    // SAFETY: valid out pointer.
    unsafe { MFCreateAttributes(&mut attributes, initial)? };
    attributes.ok_or_else(|| Error::from(E_UNEXPECTED))
}

/// Runs `f`, logging failures and turning a panic into `E_UNEXPECTED` so it
/// never unwinds into the Frame Server.
pub(crate) fn guard<T>(what: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            vlog!("{what} failed: {error}");
            Err(error)
        }
        Err(_) => {
            vlog!("{what} panicked");
            Err(E_UNEXPECTED.into())
        }
    }
}

/// `VT_I8` PROPVARIANT; owns no memory, so it needs no `PropVariantClear`.
pub(crate) fn i64_variant(value: i64) -> PROPVARIANT {
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_I8,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { hVal: value },
            }),
        },
    }
}

/// A poisoned lock still guards consistent data here (every critical
/// section is a handful of field writes), so keep serving instead of
/// panicking inside the Frame Server.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_not_found_is_the_documented_hresult() {
        assert_eq!(set_not_found().code().0 as u32, 0x8007_0492);
    }

    #[test]
    fn guard_turns_panics_into_errors() {
        let ok: Result<u8> = guard("ok", || Ok(7));
        assert_eq!(ok.unwrap(), 7);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let panicked: Result<u8> = guard("boom", || panic!("boom"));
        std::panic::set_hook(previous);
        assert_eq!(panicked.unwrap_err().code(), E_UNEXPECTED);
    }

    #[test]
    fn i64_variant_carries_the_value() {
        let variant = i64_variant(-42);
        // SAFETY: built as VT_I8 above.
        unsafe {
            assert_eq!(variant.Anonymous.Anonymous.vt, VT_I8);
            assert_eq!(variant.Anonymous.Anonymous.Anonymous.hVal, -42);
        }
    }
}
