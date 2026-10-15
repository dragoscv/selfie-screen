//! Keys, scales and note snapping.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Scale {
    #[default]
    Chromatic,
    Major,
    Minor,
    HarmonicMinor,
    MelodicMinor,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Locrian,
    MajorPentatonic,
    MinorPentatonic,
    Blues,
}

impl Scale {
    /// Pitch classes relative to the key, as a 12-bit mask (bit 0 = tonic).
    pub const fn mask(self) -> u16 {
        const fn m(steps: &[u8]) -> u16 {
            let mut out = 0u16;
            let mut i = 0;
            while i < steps.len() {
                out |= 1 << steps[i];
                i += 1;
            }
            out
        }
        match self {
            Scale::Chromatic => 0x0FFF,
            Scale::Major => m(&[0, 2, 4, 5, 7, 9, 11]),
            Scale::Minor => m(&[0, 2, 3, 5, 7, 8, 10]),
            Scale::HarmonicMinor => m(&[0, 2, 3, 5, 7, 8, 11]),
            Scale::MelodicMinor => m(&[0, 2, 3, 5, 7, 9, 11]),
            Scale::Dorian => m(&[0, 2, 3, 5, 7, 9, 10]),
            Scale::Phrygian => m(&[0, 1, 3, 5, 7, 8, 10]),
            Scale::Lydian => m(&[0, 2, 4, 6, 7, 9, 11]),
            Scale::Mixolydian => m(&[0, 2, 4, 5, 7, 9, 10]),
            Scale::Locrian => m(&[0, 1, 3, 5, 6, 8, 10]),
            Scale::MajorPentatonic => m(&[0, 2, 4, 7, 9]),
            Scale::MinorPentatonic => m(&[0, 3, 5, 7, 10]),
            Scale::Blues => m(&[0, 3, 5, 6, 7, 10]),
        }
    }
}

/// Absolute pitch-class mask (bit 0 = C) for `key` (0 = C … 11 = B), minus
/// the notes the singer switched off in `bypass` (bit per absolute class).
pub fn allowed(key: u8, scale: Scale, bypass: u16) -> u16 {
    let rel = scale.mask();
    let k = u32::from(key % 12);
    let abs = (((u32::from(rel) << k) | (u32::from(rel) >> (12 - k))) & 0x0FFF) as u16;
    let out = abs & !bypass;
    if out == 0 { abs } else { out }
}

#[inline]
fn class_of(note: i32) -> u32 {
    note.rem_euclid(12) as u32
}

/// Nearest allowed MIDI note to `midi` (fractional). `current` is the note
/// held so far: it is kept until another note is clearly closer
/// (`hysteresis` semitones past the midpoint), so a wobble on the boundary
/// does not flip the target.
pub fn nearest(midi: f32, mask: u16, current: Option<i32>, hysteresis: f32) -> i32 {
    let base = midi.round() as i32;
    let mut best = base;
    let mut best_d = f32::MAX;
    for off in -6..=6 {
        let n = base + off;
        if mask & (1 << class_of(n)) == 0 {
            continue;
        }
        let d = (midi - n as f32).abs();
        if d < best_d {
            best_d = d;
            best = n;
        }
    }
    if let Some(cur) = current
        && cur != best
        && mask & (1 << class_of(cur)) != 0
    {
        let d_cur = (midi - cur as f32).abs();
        if d_cur <= best_d + hysteresis {
            return cur;
        }
    }
    best
}

/// Semitones from `note` to the allowed note `steps` scale degrees away
/// (e.g. +2 = a diatonic third above). Chromatic falls back to semitones.
pub fn degree_offset(note: i32, mask: u16, steps: i32) -> i32 {
    if steps == 0 {
        return 0;
    }
    let dir = steps.signum();
    let mut n = note;
    let mut left = steps.abs();
    let mut guard = 0;
    while left > 0 && guard < 48 {
        n += dir;
        guard += 1;
        if mask & (1 << class_of(n)) != 0 {
            left -= 1;
        }
    }
    n - note
}

pub const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

#[inline]
pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minor_is_c_major_notes() {
        assert_eq!(allowed(9, Scale::Minor, 0), allowed(0, Scale::Major, 0));
    }

    #[test]
    fn snaps_to_scale_with_hysteresis() {
        let c_major = allowed(0, Scale::Major, 0);
        // 61.4 (C# + 40 cents) is between C#(not in scale) -> D (62) closer than C (60).
        assert_eq!(nearest(61.4, c_major, None, 0.0), 62);
        // Held C stays at 60.95 with a wide hysteresis.
        assert_eq!(nearest(60.95, c_major, Some(60), 0.3), 60);
        assert_eq!(nearest(61.6, c_major, Some(60), 0.3), 62);
    }

    #[test]
    fn bypassed_notes_are_skipped() {
        let mask = allowed(0, Scale::Major, 1 << 4); // no E
        assert_eq!(nearest(64.0, mask, None, 0.0), 65);
    }

    #[test]
    fn diatonic_third() {
        let c_major = allowed(0, Scale::Major, 0);
        assert_eq!(degree_offset(60, c_major, 2), 4); // C -> E
        assert_eq!(degree_offset(62, c_major, 2), 3); // D -> F
        assert_eq!(degree_offset(60, c_major, -2), -3); // C -> A
    }

    #[test]
    fn midi_of_a440() {
        assert!((hz_to_midi(440.0) - 69.0).abs() < 1e-4);
    }
}
