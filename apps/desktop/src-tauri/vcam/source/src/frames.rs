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
/// How often the served-sample summary goes to the log.
const REPORT_EVERY: Duration = Duration::from_secs(10);

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

/// What one sample carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Served {
    /// A frame the consumer has not seen yet.
    New,
    /// The app did not publish since the last sample: same frame again.
    Repeat,
    /// The "camera offline" picture.
    Offline,
}

/// Served-sample counters for one report window (no allocation per sample).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ServeStats {
    new: u64,
    repeat: u64,
    offline: u64,
}

impl ServeStats {
    fn record(&mut self, served: Served) {
        match served {
            Served::New => self.new += 1,
            Served::Repeat => self.repeat += 1,
            Served::Offline => self.offline += 1,
        }
    }

    /// The window's counts, resetting them.
    fn take(&mut self) -> Self {
        std::mem::take(self)
    }
}

/// Classifies a sample from the ring sequence it carried (`None` = offline).
fn classify(seq: Option<u64>, last_seq: &mut Option<u64>) -> Served {
    match seq {
        None => Served::Offline,
        Some(seq) if *last_seq == Some(seq) => Served::Repeat,
        Some(seq) => {
            *last_seq = Some(seq);
            Served::New
        }
    }
}

pub(crate) struct Frames {
    section: Option<SendSection>,
    last_attempt: Option<Instant>,
    scratch: Vec<u8>,
    offline: HashMap<(u32, u32), Vec<u8>>,
    last_origin: Option<Origin>,
    last_seq: Option<u64>,
    stats: ServeStats,
    report_at: Option<Instant>,
}

impl Frames {
    pub(crate) fn new() -> Self {
        Self {
            section: None,
            last_attempt: None,
            scratch: Vec::new(),
            offline: HashMap::new(),
            last_origin: None,
            last_seq: None,
            stats: ServeStats::default(),
            report_at: None,
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
        let seq = match self.ring() {
            Some(ring) => {
                if self.scratch.len() < SLOT_BYTES {
                    self.scratch.resize(SLOT_BYTES, 0);
                }
                ring.read_latest(&mut self.scratch, tick_ms())
                    .filter(|info| info.width == format.width && info.height == format.height)
                    .map(|info| info.seq)
            }
            None => None,
        };
        let live = seq.is_some();
        let served = classify(seq, &mut self.last_seq);
        self.record(served, format);
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

    /// Counts the sample and logs the window summary every [`REPORT_EVERY`].
    fn record(&mut self, served: Served, format: Format) {
        self.stats.record(served);
        let now = Instant::now();
        let start = *self.report_at.get_or_insert(now);
        if now.duration_since(start) >= REPORT_EVERY {
            let s = self.stats.take();
            self.report_at = Some(now);
            vlog!(
                "served new {} repeat {} offline {} in {:.1} s at {}x{}@{}",
                s.new,
                s.repeat,
                s.offline,
                now.duration_since(start).as_secs_f32(),
                format.width,
                format.height,
                format.fps
            );
        }
    }

    /// Tells the app which format the consumer negotiated (or that it stopped).
    pub(crate) fn set_active(&mut self, active: Option<Format>) {
        // A new stream starts a fresh report window.
        self.stats = ServeStats::default();
        self.report_at = None;
        if let Some(ring) = self.ring() {
            ring.set_active(active.map(Format::triple));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ServeStats, Served, classify};

    #[test]
    fn classifies_new_repeat_and_offline_samples() {
        let mut last = None;
        let served: Vec<Served> = [Some(1), Some(1), Some(2), None, Some(2), Some(3)]
            .into_iter()
            .map(|seq| classify(seq, &mut last))
            .collect();
        assert_eq!(
            served,
            [
                Served::New,
                Served::Repeat,
                Served::New,
                Served::Offline,
                Served::Repeat,
                Served::New
            ]
        );
    }

    #[test]
    fn take_returns_the_window_and_resets() {
        let mut s = ServeStats::default();
        for served in [Served::New, Served::New, Served::Repeat, Served::Offline] {
            s.record(served);
        }
        assert_eq!(
            s.take(),
            ServeStats {
                new: 2,
                repeat: 1,
                offline: 1
            }
        );
        assert_eq!(s, ServeStats::default());
    }
}
