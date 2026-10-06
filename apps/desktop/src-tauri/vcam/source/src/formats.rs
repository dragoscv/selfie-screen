//! The NV12 formats the camera offers, independent of Media Foundation so the
//! ordering and packing rules are unit-testable.

use tiksee_vcam_shared::layout::{check_dims, nv12_len};
use tiksee_vcam_shared::{Orientation, OutputConfig};

/// The only stream the source exposes.
pub(crate) const STREAM_ID: u32 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Format {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Format {
    pub(crate) const fn frame_len(self) -> usize {
        nv12_len(self.width, self.height)
    }

    /// Sample duration in 100 ns units.
    pub(crate) const fn duration_hns(self) -> i64 {
        10_000_000 / self.fps as i64
    }

    /// Uncompressed NV12 = 12 bits per pixel.
    pub(crate) const fn bitrate(self) -> u32 {
        self.width * self.height * 12 * self.fps
    }

    pub(crate) const fn triple(self) -> (u32, u32, u32) {
        (self.width, self.height, self.fps)
    }

    /// From `MF_MT_FRAME_SIZE` and `MF_MT_FRAME_RATE` packed values.
    pub(crate) fn from_packed(frame_size: u64, frame_rate: u64) -> Option<Self> {
        let (width, height) = unpack(frame_size);
        let (num, den) = unpack(frame_rate);
        if den == 0 || num == 0 || check_dims(width, height).is_err() {
            return None;
        }
        let fps = (num + den / 2) / den;
        (fps > 0).then_some(Self { width, height, fps })
    }
}

/// Default when the app has not configured the ring yet: TikTok is portrait.
pub(crate) const DEFAULT_CONFIG: OutputConfig = OutputConfig {
    orientation: Orientation::Portrait,
    fps: 60,
};

/// Every supported format, the app's requested one first, then the other
/// frame rate, then the other orientation. Frame Server and most consumers
/// pick the first type when they have no preference.
pub(crate) fn formats(requested: Option<OutputConfig>) -> Vec<Format> {
    let config = requested.unwrap_or(DEFAULT_CONFIG);
    let mut rates = vec![config.fps];
    rates.extend(OutputConfig::SUPPORTED_FPS.iter().copied().filter(|&f| f != config.fps));
    let mut out = Vec::with_capacity(4);
    for orientation in [config.orientation, config.orientation.other()] {
        let (width, height) = orientation.dims();
        for &fps in &rates {
            out.push(Format { width, height, fps });
        }
    }
    out
}

/// Media Foundation packs two u32 into one u64, high word first.
pub(crate) const fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

pub(crate) const fn unpack(value: u64) -> (u32, u32) {
    ((value >> 32) as u32, value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(width: u32, height: u32, fps: u32) -> Format {
        Format { width, height, fps }
    }

    #[test]
    fn default_lists_portrait_first_at_60() {
        assert_eq!(
            formats(None),
            vec![
                f(1080, 1920, 60),
                f(1080, 1920, 30),
                f(1920, 1080, 60),
                f(1920, 1080, 30)
            ]
        );
    }

    #[test]
    fn requested_config_comes_first() {
        let landscape30 = OutputConfig::new(Orientation::Landscape, 30).unwrap();
        assert_eq!(
            formats(Some(landscape30)),
            vec![
                f(1920, 1080, 30),
                f(1920, 1080, 60),
                f(1080, 1920, 30),
                f(1080, 1920, 60)
            ]
        );
    }

    #[test]
    fn every_format_fits_the_ring() {
        for format in formats(None) {
            assert!(check_dims(format.width, format.height).is_ok());
            assert_eq!(format.frame_len(), 1920 * 1080 * 3 / 2);
        }
    }

    #[test]
    fn pack_round_trips() {
        assert_eq!(pack(1080, 1920), 0x0000_0438_0000_0780);
        assert_eq!(unpack(pack(1920, 1080)), (1920, 1080));
    }

    #[test]
    fn from_packed_reads_size_and_rate() {
        assert_eq!(
            Format::from_packed(pack(1080, 1920), pack(60, 1)),
            Some(f(1080, 1920, 60))
        );
        assert_eq!(
            Format::from_packed(pack(1920, 1080), pack(30_000, 1001)),
            Some(f(1920, 1080, 30))
        );
        assert_eq!(Format::from_packed(pack(1920, 1080), pack(30, 0)), None);
        assert_eq!(Format::from_packed(pack(1921, 1080), pack(30, 1)), None);
    }

    #[test]
    fn timing_and_bitrate() {
        assert_eq!(f(1080, 1920, 60).duration_hns(), 166_666);
        assert_eq!(f(1080, 1920, 30).duration_hns(), 333_333);
        assert_eq!(f(1080, 1920, 60).bitrate(), 1_492_992_000);
    }
}
