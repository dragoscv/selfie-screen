//! `tiksee_vcam.dll`: the Windows Camera Frame Server custom media source
//! behind "TikSee Camera".
//!
//! Registered system-wide by `tiksee-vcam-setup.exe install` (COM class
//! under HKLM + `MFCreateVirtualCamera`). The Frame Server (LocalService,
//! session 0) loads it whenever any app opens the camera; frames come from
//! the `Global\TikSeeVcam` ring the TikSee app publishes into, or the
//! "camera offline" placeholder when the app is not running.
#![cfg(windows)]
#![allow(non_snake_case)]

#[macro_use]
mod log;
#[macro_use]
mod macros;

mod activator;
mod formats;
mod frames;
mod media_type;
mod register;
mod source;
mod stream;
mod util;

use std::ffi::c_void;
use std::panic::catch_unwind;
use std::sync::atomic::{AtomicPtr, Ordering};

use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, E_POINTER, E_UNEXPECTED, HINSTANCE, HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::Com::IClassFactory;
use windows::Win32::System::LibraryLoader::DisableThreadLibraryCalls;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows_core::{BOOL, GUID, HRESULT, Interface};

use tiksee_vcam_shared::layout::CLSID_U128;

pub(crate) const CLSID: GUID = GUID::from_u128(CLSID_U128);

static MODULE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

fn module() -> HMODULE {
    HMODULE(MODULE.load(Ordering::Acquire))
}

/// Runs an export body, converting a panic into `E_UNEXPECTED`.
fn export(f: impl FnOnce() -> HRESULT + std::panic::UnwindSafe) -> HRESULT {
    catch_unwind(f).unwrap_or(E_UNEXPECTED)
}

#[unsafe(no_mangle)]
extern "system" fn DllMain(instance: HINSTANCE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(instance.0, Ordering::Release);
        // SAFETY: our own module handle.
        unsafe {
            let _ = DisableThreadLibraryCalls(instance.into());
        }
    }
    true.into()
}

/// # Safety
/// COM contract: `clsid`, `riid` and `object` are valid pointers.
#[unsafe(no_mangle)]
unsafe extern "system" fn DllGetClassObject(
    clsid: *const GUID,
    riid: *const GUID,
    object: *mut *mut c_void,
) -> HRESULT {
    export(|| {
        if clsid.is_null() || riid.is_null() || object.is_null() {
            return E_POINTER;
        }
        // SAFETY: checked for null above.
        unsafe {
            object.write(std::ptr::null_mut());
            if *clsid != CLSID {
                return CLASS_E_CLASSNOTAVAILABLE;
            }
            let factory: IClassFactory = activator::ClassFactory.into();
            factory.query(riid, object)
        }
    })
}

/// The Frame Server keeps the DLL for the life of its process; refusing to
/// unload avoids racing late COM releases.
#[unsafe(no_mangle)]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

#[unsafe(no_mangle)]
extern "system" fn DllRegisterServer() -> HRESULT {
    export(|| match register::register(module()) {
        Ok(()) => S_OK,
        Err(error) => {
            vlog!("DllRegisterServer failed: {error}");
            error.code()
        }
    })
}

#[unsafe(no_mangle)]
extern "system" fn DllUnregisterServer() -> HRESULT {
    export(|| match register::unregister() {
        Ok(()) => S_OK,
        Err(error) => {
            vlog!("DllUnregisterServer failed: {error}");
            error.code()
        }
    })
}
