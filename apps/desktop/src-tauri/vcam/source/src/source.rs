//! The custom media source the Frame Server loads for "TikSee Camera".

use std::sync::Mutex;

use windows::Win32::Foundation::S_OK;
use windows::Win32::Media::KernelStreaming::{IKsControl, KSCAMERAPROFILE_HighFrameRate, KSCAMERAPROFILE_Legacy};
use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFGetService, IMFGetService_Impl, IMFMediaEventQueue, IMFMediaSource, IMFMediaSource_Impl,
    IMFMediaSourceEx, IMFMediaSourceEx_Impl, IMFPresentationDescriptor, IMFSampleAllocatorControl,
    IMFSampleAllocatorControl_Impl, IMFStreamDescriptor, IMFVideoSampleAllocatorEx, MENewStream, MESourceStarted,
    MESourceStopped, MEUpdatedStream, MF_DEVICEMFT_SENSORPROFILE_COLLECTION, MF_E_INVALID_STATE_TRANSITION,
    MF_E_INVALIDSTREAMNUMBER, MF_E_SHUTDOWN, MF_E_UNSUPPORTED_SERVICE, MF_E_UNSUPPORTED_TIME_FORMAT,
    MFCreatePresentationDescriptor, MFCreateSensorProfile, MFCreateSensorProfileCollection, MFGetSystemTime,
    MFMEDIASOURCE_IS_LIVE, MFSampleAllocatorUsage, MFSampleAllocatorUsage_DoesNotAllocate,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows_core::{BOOL, ComObject, GUID, IUnknown, Interface, PCWSTR, Ref, Result, implement, w};

use crate::formats::STREAM_ID;
use crate::stream::MediaStream;
use crate::util::{guard, i64_variant, lock, new_attributes};

struct Inner {
    queue: IMFMediaEventQueue,
    descriptor: IMFPresentationDescriptor,
    stream: ComObject<MediaStream>,
    /// MENewStream on the first start, MEUpdatedStream afterwards.
    stream_announced: bool,
}

#[implement(
    IMFMediaSourceEx,
    IMFAttributes,
    IMFGetService,
    IKsControl,
    IMFSampleAllocatorControl
)]
pub(crate) struct MediaSource {
    attributes: IMFAttributes,
    inner: Mutex<Option<Inner>>,
}

impl MediaSource {
    /// Creates the source, copying `activator` attributes (the Frame Server
    /// passes its configuration that way), and wires up its stream.
    pub(crate) fn create(activator: &IMFAttributes) -> Result<IMFMediaSource> {
        let attributes = new_attributes(8)?;
        // SAFETY: both stores are live.
        unsafe {
            activator.CopyAllItems(&attributes)?;
            set_sensor_profiles(&attributes);
        }
        let object = ComObject::new(Self {
            attributes,
            inner: Mutex::new(None),
        });
        let source: IMFMediaSource = object.to_interface::<IMFMediaSourceEx>().cast()?;
        let stream = ComObject::new(MediaStream::new(source.clone())?);
        let descriptors: [Option<IMFStreamDescriptor>; 1] = [Some(stream.descriptor())];
        // SAFETY: plain Media Foundation factory calls.
        let (queue, descriptor) = unsafe {
            let descriptor = MFCreatePresentationDescriptor(Some(descriptors.as_slice()))?;
            descriptor.SelectStream(0)?;
            (
                windows::Win32::Media::MediaFoundation::MFCreateEventQueue()?,
                descriptor,
            )
        };
        *lock(&object.inner) = Some(Inner {
            queue,
            descriptor,
            stream,
            stream_announced: false,
        });
        vlog!("media source created");
        Ok(source)
    }

    pub(crate) fn event_queue(&self) -> Result<IMFMediaEventQueue> {
        lock(&self.inner)
            .as_ref()
            .map(|inner| inner.queue.clone())
            .ok_or_else(|| MF_E_SHUTDOWN.into())
    }

    fn stream(&self) -> Result<ComObject<MediaStream>> {
        lock(&self.inner)
            .as_ref()
            .map(|inner| inner.stream.clone())
            .ok_or_else(|| MF_E_SHUTDOWN.into())
    }

    fn start(&self, descriptor: &IMFPresentationDescriptor, time_format: *const GUID) -> Result<()> {
        // SAFETY: a non-null time format points to a GUID owned by the caller.
        if !time_format.is_null() && unsafe { *time_format } != GUID::zeroed() {
            return Err(MF_E_UNSUPPORTED_TIME_FORMAT.into());
        }
        let queue = self.event_queue()?;
        let stream = self.stream()?;
        // SAFETY: the descriptor is a live COM object passed by the caller.
        let count = unsafe { descriptor.GetStreamDescriptorCount()? };
        for index in 0..count {
            let mut selected = BOOL::default();
            let mut sd: Option<IMFStreamDescriptor> = None;
            // SAFETY: valid out pointers.
            unsafe { descriptor.GetStreamDescriptorByIndex(index, &mut selected, &mut sd)? };
            let Some(sd) = sd else { continue };
            // SAFETY: live stream descriptor.
            if unsafe { sd.GetStreamIdentifier()? } != STREAM_ID {
                continue;
            }
            if !selected.as_bool() {
                stream.stop()?;
                continue;
            }
            let announced = {
                let mut guard = lock(&self.inner);
                let inner = guard.as_mut().ok_or(MF_E_SHUTDOWN)?;
                std::mem::replace(&mut inner.stream_announced, true)
            };
            let event = if announced { MEUpdatedStream } else { MENewStream };
            let unknown: IUnknown = stream.to_interface();
            // SAFETY: live queue, stream and descriptor.
            unsafe {
                queue.QueueEventParamUnk(event.0 as u32, &GUID::zeroed(), S_OK, &unknown)?;
                let current = sd.GetMediaTypeHandler()?.GetCurrentMediaType()?;
                stream.start(Some(&current))?;
            }
        }
        let now = i64_variant(
            // SAFETY: no preconditions.
            unsafe { MFGetSystemTime() },
        );
        // SAFETY: live queue; `now` lives across the call.
        unsafe { queue.QueueEventParamVar(MESourceStarted.0 as u32, &GUID::zeroed(), S_OK, &now) }
    }
}

/// Advertises the Legacy (<= 30 fps) and High Frame Rate (>= 60 fps) camera
/// profiles so profile-aware apps (Windows Camera, Teams) list both rates.
///
/// # Safety
/// `attributes` must be a live attribute store.
unsafe fn set_sensor_profiles(attributes: &IMFAttributes) {
    let result: Result<()> = (|| unsafe {
        let collection = MFCreateSensorProfileCollection()?;
        let profiles = [
            (&KSCAMERAPROFILE_Legacy, w!("((RES==;FRT<=30,1;SUT==))")),
            (&KSCAMERAPROFILE_HighFrameRate, w!("((RES==;FRT>=60,1;SUT==))")),
        ];
        for (kind, filter) in profiles {
            let profile = MFCreateSensorProfile(kind, 0, PCWSTR::null())?;
            profile.AddProfileFilter(STREAM_ID, filter)?;
            collection.AddProfile(&profile)?;
        }
        attributes.SetUnknown(&MF_DEVICEMFT_SENSORPROFILE_COLLECTION, &collection)
    })();
    if let Err(error) = result {
        vlog!("sensor profiles skipped: {error}");
    }
}

forward_attributes!(MediaSource_Impl, attributes);
forward_event_generator!(MediaSource_Impl);
no_ks_control!(MediaSource_Impl);

impl IMFMediaSource_Impl for MediaSource_Impl {
    fn GetCharacteristics(&self) -> Result<u32> {
        self.event_queue()?;
        Ok(MFMEDIASOURCE_IS_LIVE.0 as u32)
    }

    fn CreatePresentationDescriptor(&self) -> Result<IMFPresentationDescriptor> {
        let descriptor = lock(&self.inner)
            .as_ref()
            .map(|inner| inner.descriptor.clone())
            .ok_or(MF_E_SHUTDOWN)?;
        // SAFETY: live descriptor.
        unsafe { descriptor.Clone() }
    }

    fn Start(
        &self,
        descriptor: Ref<'_, IMFPresentationDescriptor>,
        time_format: *const GUID,
        _start_position: *const PROPVARIANT,
    ) -> Result<()> {
        let descriptor = descriptor.ok()?;
        guard("Start", || self.start(descriptor, time_format))
    }

    fn Stop(&self) -> Result<()> {
        let queue = self.event_queue()?;
        self.stream()?.stop()?;
        // SAFETY: live queue.
        unsafe { queue.QueueEventParamVar(MESourceStopped.0 as u32, &GUID::zeroed(), S_OK, std::ptr::null()) }
    }

    fn Pause(&self) -> Result<()> {
        Err(MF_E_INVALID_STATE_TRANSITION.into())
    }

    fn Shutdown(&self) -> Result<()> {
        let inner = lock(&self.inner).take().ok_or(MF_E_SHUTDOWN)?;
        inner.stream.shutdown();
        // SAFETY: live queue.
        unsafe {
            let _ = inner.queue.Shutdown();
        }
        vlog!("media source shut down");
        Ok(())
    }
}

impl IMFMediaSourceEx_Impl for MediaSource_Impl {
    fn GetSourceAttributes(&self) -> Result<IMFAttributes> {
        self.event_queue()?;
        Ok(self.attributes.clone())
    }

    fn GetStreamAttributes(&self, id: u32) -> Result<IMFAttributes> {
        if id != STREAM_ID {
            return Err(MF_E_INVALIDSTREAMNUMBER.into());
        }
        Ok(self.stream()?.attributes())
    }

    fn SetD3DManager(&self, _manager: Ref<'_, IUnknown>) -> Result<()> {
        // CPU path only: samples come from the provided allocator or system
        // memory buffers.
        self.event_queue()?;
        Ok(())
    }
}

impl IMFGetService_Impl for MediaSource_Impl {
    fn GetService(
        &self,
        _service: *const GUID,
        _riid: *const GUID,
        _object: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        Err(MF_E_UNSUPPORTED_SERVICE.into())
    }
}

impl IMFSampleAllocatorControl_Impl for MediaSource_Impl {
    fn SetDefaultAllocator(&self, id: u32, allocator: Ref<'_, IUnknown>) -> Result<()> {
        if id != STREAM_ID {
            return Err(MF_E_INVALIDSTREAMNUMBER.into());
        }
        let allocator = match allocator.as_ref() {
            Some(unknown) => Some(unknown.cast::<IMFVideoSampleAllocatorEx>()?),
            None => None,
        };
        vlog!(
            "default allocator {}",
            if allocator.is_some() { "set" } else { "cleared" }
        );
        self.stream()?.set_allocator(allocator);
        Ok(())
    }

    fn GetAllocatorUsage(&self, id: u32, input_id: *mut u32, usage: *mut MFSampleAllocatorUsage) -> Result<()> {
        if id != STREAM_ID {
            return Err(MF_E_INVALIDSTREAMNUMBER.into());
        }
        if input_id.is_null() || usage.is_null() {
            return Err(windows::Win32::Foundation::E_POINTER.into());
        }
        // SAFETY: both pointers were checked for null and belong to the caller.
        unsafe {
            input_id.write(id);
            // Samples are tight 1D NV12 buffers we allocate ourselves (see stream.rs).
            usage.write(MFSampleAllocatorUsage_DoesNotAllocate);
        }
        Ok(())
    }
}
