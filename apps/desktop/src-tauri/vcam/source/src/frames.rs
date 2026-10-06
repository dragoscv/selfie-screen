//! Where the pixels come from: the app's ring when it is publishing at the
//! negotiated size, else the cached "camera offline" frame.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tiksee_vcam_shared::layout::{SECTION_NAME, SLOT_BYTES};
use tiksee_vcam_shared::offline;
use tiksee_vcam_shared::win::{Section, tick_ms};
use tiksee_vcam_shared::{OutputConfig, Ring};

use crate::formats::{DEFAULT_CONFIG, Format};

const RETRY_EVERY: Duration = Duration::from_secs(2);

/// `Section` holds a handle and a view address; both are process-wide and
/// usable from any thread.
struct SendSection(Section);

// SAFETY: see above; the ring itself is all atomics plus a seqlock.
unsafe impl Send for SendSection {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Live,
    Offline,
}

pub(crate) struct Frames {
    section: Option<SendSection>,
    last_attempt: Option<Instant>,
    scratch: Vec<u8>,
    offline: HashMap<(u32, u32), Vec<u8>>,
    last_origin: Option<Origin>,
}

impl Frames {
    pub(crate) fn new() -> Self {
        Self {
            section: None,
            last_attempt: None,
            scratch: Vec::new(),
            offline: HashMap::new(),
            last_origin: None,
        }
    }

    /// Opens the ring without creating it (cheap probe for the requested
    /// output while building the media type list).
    pub(crate) fn probe_requested() -> Option<OutputConfig> {
        Section::open(SECTION_NAME).ok()?.ring().requested()
    }

    /// Maps the section, creating it when the app has not (LocalService
    /// holds SeCreateGlobalPrivilege). Retries at most every 2 s.
    fn ring(&mut self) -> Option<Ring> {
        if self.section.is_none() {
            let due = self.last_attempt.is_none_or(|at| at.elapsed() >= RETRY_EVERY);
            if due {
                self.last_attempt = Some(Instant::now());
                match Section::open_or_create(SECTION_NAME, DEFAULT_CONFIG) {
                    Ok(section) => {
                        vlog!("ring mapped (created={})", section.created());
                        self.section = Some(SendSection(section));
                    }
                    Err(error) => vlog!("ring unavailable: {error}"),
                }
            }
        }
        self.section.as_ref().map(|s| s.0.ring())
    }

    /// Fills `dst` (rows `pitch` bytes apart, UV plane at `pitch * height`)
    /// with the newest frame.
    pub(crate) fn fill(&mut self, format: Format, dst: &mut [u8], pitch: usize) {
        let len = format.frame_len();
        let live = match self.ring() {
            Some(ring) => {
                if self.scratch.len() < SLOT_BYTES {
                    self.scratch.resize(SLOT_BYTES, 0);
                }
                ring.read_latest(&mut self.scratch, tick_ms())
                    .is_some_and(|info| info.width == format.width && info.height == format.height)
            }
            None => false,
        };
        let origin = if live { Origin::Live } else { Origin::Offline };
        if self.last_origin != Some(origin) {
            vlog!(
                "serving {origin:?} frames at {}x{}@{}",
                format.width,
                format.height,
                format.fps
            );
            self.last_origin = Some(origin);
        }
        let src: &[u8] = if live {
            &self.scratch[..len]
        } else {
            self.offline
                .entry((format.width, format.height))
                .or_insert_with(|| offline::render_nv12(format.width, format.height).unwrap_or_else(|_| vec![16; len]))
        };
        if let Err(error) = tiksee_vcam_shared::nv12::copy_nv12_pitched(src, format.width, format.height, dst, pitch) {
            vlog!("copy failed: {error}");
        }
    }

    /// Tells the app which format the consumer negotiated (or that it stopped).
    pub(crate) fn set_active(&mut self, active: Option<Format>) {
        if let Some(ring) = self.ring() {
            ring.set_active(active.map(Format::triple));
        }
    }
}
