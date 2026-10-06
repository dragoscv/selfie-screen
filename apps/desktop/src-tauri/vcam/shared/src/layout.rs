//! Shared-memory frame ring written by TikSee and read by the media source.
//!
//! One named section (`Global\TikSeeVcam`) holds a 4 KiB header followed by
//! [`SLOT_COUNT`] NV12 frame slots sized for the largest supported output.
//! There is exactly one writer (the app). Each slot is guarded by a seqlock:
//! the writer zeroes the slot sequence, writes pixels, then publishes the new
//! sequence; a reader copies the slot and accepts it only if the sequence is
//! unchanged afterwards. Three slots mean the writer can finish a whole frame
//! while the reader is still copying the previous one without tearing it.

use std::fmt;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering, fence};

/// Media source class id, registered under `HKLM\Software\Classes\CLSID`.
pub const CLSID_U128: u128 = 0x3f1b_6c2e_8d4a_4b7e_9c51_a2e0_7d64_f8b3;
/// [`CLSID_U128`] in the `{...}` form `MFCreateVirtualCamera` expects.
pub const CLSID_STRING: &str = "{3F1B6C2E-8D4A-4B7E-9C51-A2E07D64F8B3}";
/// Camera name; Windows appends "Windows Virtual Camera" in device lists.
pub const FRIENDLY_NAME: &str = "TikSee Camera";
/// Default value of the CLSID key (shown by COM tooling).
pub const SOURCE_DESCRIPTION: &str = "TikSee Camera Media Source";
/// The Frame Server runs the source in session 0, so the section must live
/// in the global namespace to be visible to the app's session.
pub const SECTION_NAME: &str = "Global\\TikSeeVcam";

/// `HKLM` subkey that holds the COM registration of the media source.
pub fn clsid_key() -> String {
    format!("Software\\Classes\\CLSID\\{CLSID_STRING}")
}

pub const MAGIC: u32 = u32::from_le_bytes(*b"TSVC");
pub const VERSION: u32 = 1;
pub const FORMAT_NV12: u32 = 1;
pub const SLOT_COUNT: usize = 3;
pub const MAX_LONG_EDGE: u32 = 1920;
pub const MAX_SHORT_EDGE: u32 = 1080;
pub const SLOT_BYTES: usize = nv12_len(MAX_LONG_EDGE, MAX_SHORT_EDGE);
pub const HEADER_BYTES: usize = 4096;
pub const MAPPING_BYTES: usize = HEADER_BYTES + SLOT_COUNT * SLOT_BYTES;
/// A producer that has not published for this long is treated as gone and
/// the camera falls back to the "offline" frame.
pub const STALE_AFTER_MS: u64 = 1_000;

/// Bytes of one NV12 frame: a full-resolution Y plane plus a half-height
/// interleaved UV plane.
pub const fn nv12_len(width: u32, height: u32) -> usize {
    (width as usize) * (height as usize) * 3 / 2
}

/// Ring slot that holds sequence number `seq`.
pub const fn slot_index(seq: u64) -> usize {
    (seq % SLOT_COUNT as u64) as usize
}

#[repr(C)]
pub struct SlotHeader {
    /// Sequence of the frame in the slot; 0 while it is being written.
    pub seq: AtomicU64,
    pub width: AtomicU32,
    pub height: AtomicU32,
}

#[repr(C)]
pub struct Header {
    pub magic: AtomicU32,
    pub version: AtomicU32,
    pub format: AtomicU32,
    pub slot_count: AtomicU32,
    pub slot_bytes: AtomicU32,
    /// Output the app asked for; the source lists it first on activation.
    pub cfg_width: AtomicU32,
    pub cfg_height: AtomicU32,
    pub cfg_fps: AtomicU32,
    /// Format the consuming app negotiated (0 while not streaming), written
    /// by the source so the app can render at exactly that size.
    pub active_width: AtomicU32,
    pub active_height: AtomicU32,
    pub active_fps: AtomicU32,
    pub _reserved: AtomicU32,
    /// Sequence of the newest complete frame; 0 = nothing published yet.
    pub latest_seq: AtomicU64,
    /// `GetTickCount64` of the last publish (system-wide, all sessions).
    pub heartbeat_ms: AtomicU64,
    pub slots: [SlotHeader; SLOT_COUNT],
}

const _: () = assert!(size_of::<Header>() == 112);
const _: () = assert!(size_of::<Header>() <= HEADER_BYTES);
const _: () = assert!(HEADER_BYTES.is_multiple_of(8) && SLOT_BYTES.is_multiple_of(8));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Landscape,
    Portrait,
}

impl Orientation {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "landscape" => Some(Self::Landscape),
            "portrait" => Some(Self::Portrait),
            _ => None,
        }
    }

    pub const fn other(self) -> Self {
        match self {
            Self::Landscape => Self::Portrait,
            Self::Portrait => Self::Landscape,
        }
    }

    pub const fn dims(self) -> (u32, u32) {
        match self {
            Self::Landscape => (MAX_LONG_EDGE, MAX_SHORT_EDGE),
            Self::Portrait => (MAX_SHORT_EDGE, MAX_LONG_EDGE),
        }
    }
}

/// Output format of the virtual camera.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputConfig {
    pub orientation: Orientation,
    pub fps: u32,
}

impl OutputConfig {
    pub const SUPPORTED_FPS: [u32; 2] = [60, 30];

    pub fn new(orientation: Orientation, fps: u32) -> Option<Self> {
        Self::SUPPORTED_FPS.contains(&fps).then_some(Self { orientation, fps })
    }

    pub fn from_dims(width: u32, height: u32, fps: u32) -> Option<Self> {
        let orientation = [Orientation::Landscape, Orientation::Portrait]
            .into_iter()
            .find(|o| o.dims() == (width, height))?;
        Self::new(orientation, fps)
    }

    pub const fn dims(self) -> (u32, u32) {
        self.orientation.dims()
    }
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            orientation: Orientation::Landscape,
            fps: 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameInfo {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
}

impl FrameInfo {
    pub const fn len(&self) -> usize {
        nv12_len(self.width, self.height)
    }

    pub const fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// NV12 subsamples chroma 2x2, so both edges must be even and non-zero.
    BadDimensions {
        width: u32,
        height: u32,
    },
    TooLarge {
        width: u32,
        height: u32,
    },
    WrongLength {
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadDimensions { width, height } => {
                write!(f, "frame {width}x{height}: edges must be even and non-zero")
            }
            Self::TooLarge { width, height } => {
                write!(f, "frame {width}x{height} exceeds {MAX_LONG_EDGE}x{MAX_SHORT_EDGE}")
            }
            Self::WrongLength { expected, actual } => {
                write!(f, "expected {expected} bytes, got {actual}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// Rejects dimensions the ring (and NV12) cannot hold.
pub fn check_dims(width: u32, height: u32) -> Result<(), FrameError> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(FrameError::BadDimensions { width, height });
    }
    if nv12_len(width, height) > SLOT_BYTES || width.max(height) > MAX_LONG_EDGE || width.min(height) > MAX_SHORT_EDGE {
        return Err(FrameError::TooLarge { width, height });
    }
    Ok(())
}

/// View over a mapped ring. Cheap to copy around; owns nothing.
#[derive(Clone, Copy)]
pub struct Ring {
    base: NonNull<u8>,
}

// SAFETY: every shared field is atomic; pixel slots are guarded by the
// per-slot seqlock and there is a single writer by contract.
unsafe impl Send for Ring {}
unsafe impl Sync for Ring {}

impl Ring {
    /// # Safety
    /// `base` must be 8-byte aligned and point to at least [`MAPPING_BYTES`]
    /// readable and writable bytes that outlive every use of the `Ring`.
    pub unsafe fn from_raw(base: *mut u8) -> Option<Self> {
        let base = NonNull::new(base)?;
        (base.as_ptr() as usize).is_multiple_of(8).then_some(Self { base })
    }

    fn header(&self) -> &Header {
        // SAFETY: from_raw guarantees size and alignment; Header is all atomics.
        unsafe { &*self.base.as_ptr().cast::<Header>() }
    }

    fn slot_ptr(&self, index: usize) -> *mut u8 {
        debug_assert!(index < SLOT_COUNT);
        // SAFETY: index < SLOT_COUNT keeps the offset inside MAPPING_BYTES.
        unsafe { self.base.as_ptr().add(HEADER_BYTES + index * SLOT_BYTES) }
    }

    /// Run once by whoever created the section. Publishes `magic` last so a
    /// reader never sees a half-initialised header as valid.
    pub fn initialize(&self, config: OutputConfig) {
        let h = self.header();
        h.latest_seq.store(0, Ordering::Relaxed);
        h.heartbeat_ms.store(0, Ordering::Relaxed);
        self.set_active(None);
        for slot in &h.slots {
            slot.seq.store(0, Ordering::Relaxed);
            slot.width.store(0, Ordering::Relaxed);
            slot.height.store(0, Ordering::Relaxed);
        }
        h.format.store(FORMAT_NV12, Ordering::Relaxed);
        h.slot_count.store(SLOT_COUNT as u32, Ordering::Relaxed);
        h.slot_bytes.store(SLOT_BYTES as u32, Ordering::Relaxed);
        self.configure(config);
        h.version.store(VERSION, Ordering::Relaxed);
        h.magic.store(MAGIC, Ordering::Release);
    }

    pub fn is_initialized(&self) -> bool {
        let h = self.header();
        h.magic.load(Ordering::Acquire) == MAGIC
            && h.version.load(Ordering::Relaxed) == VERSION
            && h.slot_bytes.load(Ordering::Relaxed) == SLOT_BYTES as u32
    }

    pub fn configure(&self, config: OutputConfig) {
        let h = self.header();
        let (width, height) = config.dims();
        h.cfg_width.store(width, Ordering::Relaxed);
        h.cfg_height.store(height, Ordering::Relaxed);
        h.cfg_fps.store(config.fps, Ordering::Release);
    }

    pub fn requested(&self) -> Option<OutputConfig> {
        if !self.is_initialized() {
            return None;
        }
        let h = self.header();
        let fps = h.cfg_fps.load(Ordering::Acquire);
        OutputConfig::from_dims(
            h.cfg_width.load(Ordering::Relaxed),
            h.cfg_height.load(Ordering::Relaxed),
            fps,
        )
    }

    /// Records (or clears) the format the consumer is streaming.
    pub fn set_active(&self, active: Option<(u32, u32, u32)>) {
        let h = self.header();
        let (width, height, fps) = active.unwrap_or_default();
        h.active_width.store(width, Ordering::Relaxed);
        h.active_height.store(height, Ordering::Relaxed);
        h.active_fps.store(fps, Ordering::Release);
    }

    /// `(width, height, fps)` the consumer negotiated, if it is streaming.
    pub fn active(&self) -> Option<(u32, u32, u32)> {
        if !self.is_initialized() {
            return None;
        }
        let h = self.header();
        let fps = h.active_fps.load(Ordering::Acquire);
        let width = h.active_width.load(Ordering::Relaxed);
        let height = h.active_height.load(Ordering::Relaxed);
        (fps != 0 && check_dims(width, height).is_ok()).then_some((width, height, fps))
    }

    /// Writes one frame through `fill` straight into the next slot (no extra
    /// copy) and publishes it. Returns the new sequence number. When `fill`
    /// fails the slot stays invalid and `latest_seq` keeps pointing at the
    /// previous frame, so readers never see the partial write.
    pub fn publish_with<E>(
        &self,
        width: u32,
        height: u32,
        now_ms: u64,
        fill: impl FnOnce(&mut [u8]) -> Result<(), E>,
    ) -> Result<u64, E>
    where
        E: From<FrameError>,
    {
        check_dims(width, height)?;
        let h = self.header();
        let next = h.latest_seq.load(Ordering::Relaxed) + 1;
        let index = slot_index(next);
        let slot = &h.slots[index];

        slot.seq.store(0, Ordering::Relaxed);
        fence(Ordering::Release);
        // SAFETY: the slot is SLOT_BYTES long and check_dims bounds the length;
        // this process is the only writer.
        let pixels = unsafe { std::slice::from_raw_parts_mut(self.slot_ptr(index), nv12_len(width, height)) };
        fill(pixels)?;
        slot.width.store(width, Ordering::Relaxed);
        slot.height.store(height, Ordering::Relaxed);
        slot.seq.store(next, Ordering::Release);
        h.latest_seq.store(next, Ordering::Release);
        h.heartbeat_ms.store(now_ms, Ordering::Release);
        Ok(next)
    }

    /// Copies the newest complete frame into `dst`. `None` when nothing was
    /// published, the producer went quiet for [`STALE_AFTER_MS`], or every
    /// attempt raced the writer.
    pub fn read_latest(&self, dst: &mut [u8], now_ms: u64) -> Option<FrameInfo> {
        if !self.is_initialized() {
            return None;
        }
        let h = self.header();
        for _ in 0..SLOT_COUNT {
            let seq = h.latest_seq.load(Ordering::Acquire);
            if seq == 0 {
                return None;
            }
            let heartbeat = h.heartbeat_ms.load(Ordering::Acquire);
            if now_ms.saturating_sub(heartbeat) > STALE_AFTER_MS {
                return None;
            }
            let index = slot_index(seq);
            let slot = &h.slots[index];
            if slot.seq.load(Ordering::Acquire) != seq {
                continue;
            }
            let info = FrameInfo {
                seq,
                width: slot.width.load(Ordering::Relaxed),
                height: slot.height.load(Ordering::Relaxed),
            };
            if check_dims(info.width, info.height).is_err() || dst.len() < info.len() {
                return None;
            }
            // SAFETY: the slot holds at least info.len() bytes (check_dims) and
            // dst was length-checked above.
            unsafe {
                std::ptr::copy_nonoverlapping(self.slot_ptr(index), dst.as_mut_ptr(), info.len());
            }
            fence(Ordering::Acquire);
            if slot.seq.load(Ordering::Relaxed) == seq {
                return Some(info);
            }
        }
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Heap stand-in for the mapped section (u64 backing = 8-byte aligned).
    pub(crate) struct TestMapping(Vec<u64>);

    impl TestMapping {
        pub(crate) fn new() -> Self {
            Self(vec![0; MAPPING_BYTES / 8])
        }

        pub(crate) fn ring(&mut self) -> Ring {
            // SAFETY: the Vec is MAPPING_BYTES long, aligned, and outlives the test.
            unsafe { Ring::from_raw(self.0.as_mut_ptr().cast()) }.expect("ring")
        }
    }

    #[test]
    fn header_fits_its_page_and_slots_hold_the_largest_frame() {
        assert_eq!(size_of::<Header>(), 112);
        assert_eq!(std::mem::offset_of!(Header, cfg_width), 20);
        assert_eq!(std::mem::offset_of!(Header, active_width), 32);
        assert_eq!(std::mem::offset_of!(Header, latest_seq), 48);
        assert_eq!(std::mem::offset_of!(Header, heartbeat_ms), 56);
        assert_eq!(std::mem::offset_of!(Header, slots), 64);
        assert_eq!(size_of::<SlotHeader>(), 16);
        assert_eq!(SLOT_BYTES, 1920 * 1080 * 3 / 2);
        assert_eq!(MAPPING_BYTES, 4096 + 3 * 3_110_400);
    }

    #[test]
    fn clsid_string_matches_the_numeric_clsid() {
        let hex = format!("{CLSID_U128:032X}");
        let expected = format!(
            "{{{}-{}-{}-{}-{}}}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        );
        assert_eq!(CLSID_STRING, expected);
        assert_eq!(
            clsid_key(),
            "Software\\Classes\\CLSID\\{3F1B6C2E-8D4A-4B7E-9C51-A2E07D64F8B3}"
        );
    }

    #[test]
    fn active_format_round_trips_and_clears() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        assert_eq!(ring.active(), None, "uninitialised");
        ring.initialize(OutputConfig::default());
        assert_eq!(ring.active(), None);
        ring.set_active(Some((1080, 1920, 60)));
        assert_eq!(ring.active(), Some((1080, 1920, 60)));
        ring.set_active(None);
        assert_eq!(ring.active(), None);
        ring.set_active(Some((1081, 1920, 60)));
        assert_eq!(ring.active(), None, "odd width is never reported");
    }

    #[test]
    fn slot_index_cycles_through_every_slot() {
        let seen: Vec<usize> = (1..=6).map(slot_index).collect();
        assert_eq!(seen, vec![1, 2, 0, 1, 2, 0]);
    }

    #[test]
    fn uninitialised_ring_yields_nothing() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        let mut dst = vec![0; SLOT_BYTES];
        assert!(!ring.is_initialized());
        assert_eq!(ring.requested(), None);
        assert_eq!(ring.read_latest(&mut dst, 10), None);
    }

    #[test]
    fn initialise_records_layout_and_requested_output() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        let portrait = OutputConfig::new(Orientation::Portrait, 30).unwrap();
        ring.initialize(portrait);
        assert!(ring.is_initialized());
        assert_eq!(ring.requested(), Some(portrait));
        ring.configure(OutputConfig::default());
        assert_eq!(ring.requested(), Some(OutputConfig::default()));
    }

    #[test]
    fn published_frames_round_trip_and_advance_through_slots() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        let mut dst = vec![0; SLOT_BYTES];
        for (value, expected_seq) in [(10u8, 1u64), (20, 2), (30, 3), (40, 4)] {
            let seq = ring.publish_with(4, 2, 100, fill(value)).expect("publish");
            assert_eq!(seq, expected_seq);
            let info = ring.read_latest(&mut dst, 150).expect("frame");
            assert_eq!(
                info,
                FrameInfo {
                    seq,
                    width: 4,
                    height: 2
                }
            );
            assert!(dst[..info.len()].iter().all(|&b| b == value));
        }
    }

    #[test]
    fn older_slots_survive_while_the_next_is_written() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        ring.publish_with(2, 2, 0, fill(1)).unwrap();
        // Simulate a writer stopped mid-frame on seq 2: the slot is zeroed
        // but latest still says 1, so the reader keeps getting frame 1.
        ring.header().slots[slot_index(2)].seq.store(0, Ordering::Relaxed);
        let mut dst = vec![0; 6];
        assert_eq!(ring.read_latest(&mut dst, 0).map(|f| f.seq), Some(1));
    }

    #[test]
    fn torn_slot_is_rejected() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        ring.publish_with(2, 2, 0, fill(7)).unwrap();
        ring.header().slots[slot_index(1)].seq.store(0, Ordering::Relaxed);
        let mut dst = vec![0; 6];
        assert_eq!(ring.read_latest(&mut dst, 0), None);
    }

    #[test]
    fn stale_producer_reads_as_offline() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        ring.publish_with(2, 2, 5_000, fill(9)).unwrap();
        let mut dst = vec![0; 6];
        assert!(ring.read_latest(&mut dst, 5_000 + STALE_AFTER_MS).is_some());
        assert!(ring.read_latest(&mut dst, 5_001 + STALE_AFTER_MS).is_none());
    }

    #[test]
    fn bad_dimensions_are_refused_before_touching_the_ring() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        for (w, h) in [(0, 2), (3, 2), (2, 3), (1922, 1080), (1920, 1082), (1080, 1922)] {
            let result = ring.publish_with(w, h, 0, |_: &mut [u8]| -> Result<(), FrameError> { panic!("filled") });
            assert!(result.is_err(), "{w}x{h}");
        }
        assert!(ring.publish_with(1080, 1920, 0, fill(0)).is_ok());
        let mut small = vec![0; 10];
        assert_eq!(ring.read_latest(&mut small, 0), None, "dst too small");
    }

    #[test]
    fn failed_fill_keeps_the_previous_frame_current() {
        let mut mapping = TestMapping::new();
        let ring = mapping.ring();
        ring.initialize(OutputConfig::default());
        ring.publish_with(2, 2, 0, fill(3)).unwrap();
        let failed = ring.publish_with(2, 2, 0, |_: &mut [u8]| {
            Err(FrameError::WrongLength { expected: 1, actual: 0 })
        });
        assert!(failed.is_err());
        let mut dst = vec![0; 6];
        let info = ring.read_latest(&mut dst, 0).expect("previous frame");
        assert_eq!(info.seq, 1);
        assert_eq!(dst, vec![3; 6]);
    }

    fn fill(value: u8) -> impl FnOnce(&mut [u8]) -> Result<(), FrameError> {
        move |px| {
            px.fill(value);
            Ok(())
        }
    }

    #[test]
    fn output_config_parses_and_validates() {
        assert_eq!(Orientation::parse("portrait"), Some(Orientation::Portrait));
        assert_eq!(Orientation::parse("square"), None);
        assert_eq!(Orientation::Landscape.other(), Orientation::Portrait);
        assert!(OutputConfig::new(Orientation::Landscape, 25).is_none());
        assert_eq!(
            OutputConfig::from_dims(1080, 1920, 60),
            OutputConfig::new(Orientation::Portrait, 60)
        );
        assert_eq!(OutputConfig::from_dims(1280, 720, 60), None);
    }
}
