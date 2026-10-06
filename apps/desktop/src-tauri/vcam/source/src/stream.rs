//! The single video stream of the TikSee Camera source.

use std::sync::Mutex;

use windows::Win32::Foundation::{E_POINTER, S_OK};
use windows::Win32::Media::KernelStreaming::{IKsControl, PINNAME_VIDEO_CAPTURE};
use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer, IMF2DBuffer2, IMFAttributes, IMFMediaBuffer, IMFMediaEventQueue, IMFMediaSource, IMFMediaStream_Impl,
    IMFMediaStream2, IMFMediaStream2_Impl, IMFMediaType, IMFSample, IMFStreamDescriptor, IMFVideoSampleAllocatorEx,
    MEMediaSample, MEStreamStarted, MEStreamStopped, MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
    MF_DEVICESTREAM_FRAMESERVER_SHARED, MF_DEVICESTREAM_STREAM_CATEGORY, MF_DEVICESTREAM_STREAM_ID,
    MF_E_INVALID_STATE_TRANSITION, MF_E_INVALIDMEDIATYPE, MF_E_INVALIDREQUEST, MF_E_SHUTDOWN, MF_STREAM_STATE,
    MF_STREAM_STATE_PAUSED, MF_STREAM_STATE_RUNNING, MF_STREAM_STATE_STOPPED, MF2DBuffer_LockFlags_Write,
    MFCreateEventQueue, MFCreateMemoryBuffer, MFCreateSample, MFCreateStreamDescriptor, MFFrameSourceTypes_Color,
    MFGetSystemTime, MFSampleExtension_Token,
};
use windows_core::{GUID, IUnknown, Interface, Ref, Result, implement};

use crate::formats::{Format, STREAM_ID, formats};
use crate::frames::Frames;
use crate::media_type;
use crate::util::{lock, new_attributes};

/// Samples the provided allocator keeps in flight.
const ALLOCATOR_SAMPLES: u32 = 10;

struct State {
    state: MF_STREAM_STATE,
    allocator: Option<IMFVideoSampleAllocatorEx>,
    format: Option<Format>,
    frames: Frames,
}

#[implement(IMFMediaStream2, IMFAttributes, IKsControl)]
pub(crate) struct MediaStream {
    attributes: IMFAttributes,
    queue: Mutex<Option<IMFMediaEventQueue>>,
    descriptor: IMFStreamDescriptor,
    source: Mutex<Option<IMFMediaSource>>,
    state: Mutex<State>,
}

impl MediaStream {
    pub(crate) fn new(source: IMFMediaSource) -> Result<Self> {
        let attributes = new_attributes(4)?;
        let requested = Frames::probe_requested();
        let types = formats(requested)
            .into_iter()
            .map(|format| media_type::create(format).map(Some))
            .collect::<Result<Vec<Option<IMFMediaType>>>>()?;
        // SAFETY: plain Media Foundation calls on objects we own.
        let (queue, descriptor) = unsafe {
            set_stream_attributes(&attributes)?;
            let queue = MFCreateEventQueue()?;
            let descriptor = MFCreateStreamDescriptor(STREAM_ID, &types)?;
            set_stream_attributes(&descriptor)?;
            let handler = descriptor.GetMediaTypeHandler()?;
            handler.SetCurrentMediaType(types[0].as_ref())?;
            (queue, descriptor)
        };
        vlog!("stream created, first type {:?}", formats(requested)[0]);
        Ok(Self {
            attributes,
            queue: Mutex::new(Some(queue)),
            descriptor,
            source: Mutex::new(Some(source)),
            state: Mutex::new(State {
                state: MF_STREAM_STATE_STOPPED,
                allocator: None,
                format: None,
                frames: Frames::new(),
            }),
        })
    }

    pub(crate) fn event_queue(&self) -> Result<IMFMediaEventQueue> {
        lock(&self.queue).clone().ok_or_else(|| MF_E_SHUTDOWN.into())
    }

    pub(crate) fn attributes(&self) -> IMFAttributes {
        self.attributes.clone()
    }

    pub(crate) fn descriptor(&self) -> IMFStreamDescriptor {
        self.descriptor.clone()
    }

    pub(crate) fn set_allocator(&self, allocator: Option<IMFVideoSampleAllocatorEx>) {
        lock(&self.state).allocator = allocator;
    }

    fn current_type(&self) -> Result<IMFMediaType> {
        // SAFETY: descriptor and handler are live COM objects.
        unsafe { self.descriptor.GetMediaTypeHandler()?.GetCurrentMediaType() }
    }

    /// Starts (or restarts) streaming `media_type`, or the current type.
    pub(crate) fn start(&self, media_type: Option<&IMFMediaType>) -> Result<()> {
        let queue = self.event_queue()?;
        let media_type = match media_type {
            Some(t) => t.clone(),
            None => self.current_type()?,
        };
        let format = media_type::format_of(&media_type).ok_or(MF_E_INVALIDMEDIATYPE)?;
        let mut state = lock(&self.state);
        if let Some(allocator) = &state.allocator {
            // SAFETY: allocator came from the Frame Server via SetDefaultAllocator.
            unsafe {
                let _ = allocator.UninitializeSampleAllocator();
                allocator.InitializeSampleAllocator(ALLOCATOR_SAMPLES, &media_type)?;
            }
        }
        state.format = Some(format);
        state.state = MF_STREAM_STATE_RUNNING;
        state.frames.set_active(Some(format));
        drop(state);
        vlog!("stream started {}x{}@{}", format.width, format.height, format.fps);
        // SAFETY: queue is live; a null value is allowed.
        unsafe { queue.QueueEventParamVar(MEStreamStarted.0 as u32, &GUID::zeroed(), S_OK, std::ptr::null()) }
    }

    pub(crate) fn stop(&self) -> Result<()> {
        let queue = self.event_queue()?;
        self.halt();
        vlog!("stream stopped");
        // SAFETY: queue is live; a null value is allowed.
        unsafe { queue.QueueEventParamVar(MEStreamStopped.0 as u32, &GUID::zeroed(), S_OK, std::ptr::null()) }
    }

    fn halt(&self) {
        let mut state = lock(&self.state);
        if let Some(allocator) = &state.allocator {
            // SAFETY: allocator is live.
            unsafe {
                let _ = allocator.UninitializeSampleAllocator();
            }
        }
        if state.state != MF_STREAM_STATE_STOPPED {
            state.frames.set_active(None);
        }
        state.state = MF_STREAM_STATE_STOPPED;
        state.format = None;
    }

    pub(crate) fn shutdown(&self) {
        self.halt();
        lock(&self.state).allocator = None;
        if let Some(queue) = lock(&self.queue).take() {
            // SAFETY: queue is live.
            unsafe {
                let _ = queue.Shutdown();
            }
        }
        // Breaks the source <-> stream reference cycle.
        lock(&self.source).take();
    }

    fn sample(&self, state: &mut State, format: Format) -> Result<IMFSample> {
        // SAFETY: Media Foundation calls on live objects; the locked buffer
        // is only touched between Lock and Unlock and within its length.
        unsafe {
            // Always a tight 1D buffer (stride == width, UV right after Y).
            // The provided allocator hands out 2D buffers padded to a 1088
            // pitch; the direct NV12 reader honoured MF_MT_DEFAULT_STRIDE
            // while Windows' NV12->YUY2 converter honoured the buffer pitch,
            // so one of them always saw a sheared or colour-striped picture
            // (measured with ffmpeg dshow in both pixel formats, 2026-10-06).
            let sample = MFCreateSample()?;
            let buffer = MFCreateMemoryBuffer(format.frame_len() as u32)?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(MFGetSystemTime())?;
            sample.SetSampleDuration(format.duration_hns())?;
            let buffer = sample.GetBufferByIndex(0)?;
            fill_buffer(&buffer, state, format)?;
            Ok(sample)
        }
    }
}

/// # Safety
/// `buffer` must be a live media buffer of `format`.
unsafe fn fill_buffer(buffer: &IMFMediaBuffer, state: &mut State, format: Format) -> Result<()> {
    let rows = (format.height + format.height / 2) as usize;
    unsafe {
        if let Ok(buffer2) = buffer.cast::<IMF2DBuffer2>() {
            let (mut scan0, mut pitch, mut start, mut len) = (std::ptr::null_mut(), 0i32, std::ptr::null_mut(), 0u32);
            buffer2.Lock2DSize(MF2DBuffer_LockFlags_Write, &mut scan0, &mut pitch, &mut start, &mut len)?;
            let result = fill_locked(state, format, scan0, pitch, len as usize);
            let _ = buffer2.Unlock2D();
            return result;
        }
        if let Ok(buffer2d) = buffer.cast::<IMF2DBuffer>() {
            let (mut scan0, mut pitch) = (std::ptr::null_mut(), 0i32);
            buffer2d.Lock2D(&mut scan0, &mut pitch)?;
            let len = (pitch.max(0) as usize) * rows;
            let result = fill_locked(state, format, scan0, pitch, len);
            let _ = buffer2d.Unlock2D();
            return result;
        }
        let (mut data, mut max) = (std::ptr::null_mut(), 0u32);
        buffer.Lock(&mut data, Some(&raw mut max), None)?;
        let len = format.frame_len();
        let result: Result<()> = if data.is_null() || (max as usize) < len {
            Err(E_POINTER.into())
        } else {
            state
                .frames
                .fill(format, std::slice::from_raw_parts_mut(data, len), format.width as usize);
            Ok(())
        };
        let _ = buffer.Unlock();
        result?;
        buffer.SetCurrentLength(len as u32)
    }
}

/// # Safety
/// `scan0` must point to `available` writable bytes (the locked buffer).
unsafe fn fill_locked(state: &mut State, format: Format, scan0: *mut u8, pitch: i32, available: usize) -> Result<()> {
    // Bottom-up (negative pitch) layouts never occur for NV12 but would
    // need reversed rows; refuse them rather than write out of bounds.
    if scan0.is_null() || pitch < format.width as i32 {
        return Err(E_POINTER.into());
    }
    let rows = (format.height + format.height / 2) as usize;
    let len = pitch as usize * rows;
    if available < len {
        return Err(E_POINTER.into());
    }
    // SAFETY: caller guarantees `available >= len` writable bytes.
    let dst = unsafe { std::slice::from_raw_parts_mut(scan0, len) };
    state.frames.fill(format, dst, pitch as usize);
    Ok(())
}

/// # Safety
/// `attributes` must be a live attribute store.
unsafe fn set_stream_attributes(attributes: &IMFAttributes) -> Result<()> {
    unsafe {
        attributes.SetGUID(&MF_DEVICESTREAM_STREAM_CATEGORY, &PINNAME_VIDEO_CAPTURE)?;
        attributes.SetUINT32(&MF_DEVICESTREAM_STREAM_ID, STREAM_ID)?;
        attributes.SetUINT32(&MF_DEVICESTREAM_FRAMESERVER_SHARED, 1)?;
        attributes.SetUINT32(
            &MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
            MFFrameSourceTypes_Color.0 as u32,
        )
    }
}

forward_attributes!(MediaStream_Impl, attributes);
forward_event_generator!(MediaStream_Impl);
no_ks_control!(MediaStream_Impl);

impl IMFMediaStream_Impl for MediaStream_Impl {
    fn GetMediaSource(&self) -> Result<IMFMediaSource> {
        lock(&self.source).clone().ok_or_else(|| MF_E_SHUTDOWN.into())
    }

    fn GetStreamDescriptor(&self) -> Result<IMFStreamDescriptor> {
        self.event_queue()?;
        Ok(self.descriptor.clone())
    }

    fn RequestSample(&self, token: Ref<'_, IUnknown>) -> Result<()> {
        let queue = self.event_queue()?;
        let mut state = lock(&self.state);
        let format = match (state.state, state.format) {
            (MF_STREAM_STATE_RUNNING, Some(format)) => format,
            _ => return Err(MF_E_INVALIDREQUEST.into()),
        };
        let sample = self.sample(&mut state, format)?;
        drop(state);
        // SAFETY: sample and queue are live.
        unsafe {
            if let Some(token) = token.as_ref() {
                sample.SetUnknown(&MFSampleExtension_Token, token)?;
            }
            queue.QueueEventParamUnk(MEMediaSample.0 as u32, &GUID::zeroed(), S_OK, &sample)
        }
    }
}

impl IMFMediaStream2_Impl for MediaStream_Impl {
    fn SetStreamState(&self, value: MF_STREAM_STATE) -> Result<()> {
        let current = lock(&self.state).state;
        if value == current {
            return Ok(());
        }
        match value {
            MF_STREAM_STATE_RUNNING => self.start(None),
            MF_STREAM_STATE_STOPPED => self.stop(),
            MF_STREAM_STATE_PAUSED => Err(MF_E_INVALID_STATE_TRANSITION.into()),
            _ => Err(MF_E_INVALIDREQUEST.into()),
        }
    }

    fn GetStreamState(&self) -> Result<MF_STREAM_STATE> {
        self.event_queue()?;
        Ok(lock(&self.state).state)
    }
}
