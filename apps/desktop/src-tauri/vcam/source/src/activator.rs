//! Class factory and activator.
//!
//! The Frame Server `CoCreateInstance`s the CLSID registered with
//! `MFCreateVirtualCamera`, expects an `IMFActivate`, and later calls
//! `ActivateObject` to get the media source.

use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, Ordering};

use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_NOINTERFACE, E_POINTER};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFActivate_Impl, IMFAttributes, IMFMediaSource, MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES,
    MFT_TRANSFORM_CLSID_Attribute,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows_core::{BOOL, GUID, IUnknown, Interface, Ref, Result, implement};

use crate::CLSID;
use crate::source::MediaSource;
use crate::util::{guard, lock, new_attributes};

/// Outstanding `LockServer(TRUE)` calls (DllCanUnloadNow always says no).
pub(crate) static SERVER_LOCKS: AtomicIsize = AtomicIsize::new(0);

#[implement(IClassFactory)]
pub(crate) struct ClassFactory;

impl IClassFactory_Impl for ClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, IUnknown>,
        riid: *const GUID,
        object: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        if object.is_null() || riid.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: checked for null above.
        unsafe { object.write(std::ptr::null_mut()) };
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        guard("CreateInstance", || {
            let activate: IMFActivate = Activator::new()?.into();
            // SAFETY: riid and object are valid pointers from the caller.
            unsafe { activate.query(riid, object).ok() }
        })
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        SERVER_LOCKS.fetch_add(if lock.as_bool() { 1 } else { -1 }, Ordering::SeqCst);
        Ok(())
    }
}

#[implement(IMFActivate, IMFAttributes)]
pub(crate) struct Activator {
    attributes: IMFAttributes,
    source: Mutex<Option<IMFMediaSource>>,
}

impl Activator {
    fn new() -> Result<Self> {
        let attributes = new_attributes(2)?;
        // SAFETY: plain attribute writes on our own store.
        unsafe {
            attributes.SetUINT32(&MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES, 1)?;
            attributes.SetGUID(&MFT_TRANSFORM_CLSID_Attribute, &CLSID)?;
        }
        vlog!("activator created");
        Ok(Self {
            attributes,
            source: Mutex::new(None),
        })
    }
}

forward_attributes!(Activator_Impl, attributes);

impl IMFActivate_Impl for Activator_Impl {
    fn ActivateObject(&self, riid: *const GUID, object: *mut *mut core::ffi::c_void) -> Result<()> {
        if object.is_null() || riid.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: checked for null above.
        unsafe { object.write(std::ptr::null_mut()) };
        guard("ActivateObject", || {
            let mut slot = lock(&self.source);
            let source = match slot.as_ref() {
                Some(source) => source.clone(),
                None => {
                    let source = MediaSource::create(&self.attributes)?;
                    *slot = Some(source.clone());
                    source
                }
            };
            // SAFETY: riid and object are valid pointers from the caller.
            let hr = unsafe { source.query(riid, object) };
            if hr.is_err() {
                return Err(if hr == E_NOINTERFACE { E_NOINTERFACE } else { hr }.into());
            }
            Ok(())
        })
    }

    fn ShutdownObject(&self) -> Result<()> {
        if let Some(source) = lock(&self.source).take() {
            // SAFETY: live source.
            unsafe {
                let _ = source.Shutdown();
            }
        }
        Ok(())
    }

    fn DetachObject(&self) -> Result<()> {
        lock(&self.source).take();
        Ok(())
    }
}
