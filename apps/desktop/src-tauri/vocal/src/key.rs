//! Key detection on the music bus (chroma + Krumhansl–Schmuckler profiles)
//! and the music ducker.
//!
//! The chroma is built from a Goertzel bank over MIDI notes 36–95 on a
//! decimated mono signal, so it costs ~60 filters per 4096-sample block and
//! never allocates after construction.

use crate::fx::coef_ms;
use crate::scale::Scale;

const KS_MAJOR: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const KS_MINOR: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const LOW_NOTE: i32 = 36;
const NOTES: usize = 60;
const BLOCK: usize = 4096;
const DECIMATE: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyGuess {
    pub key: u8,
    pub scale: Scale,
    /// Correlation of the winner, -1..1.
    pub confidence: f32,
}

pub struct KeyDetector {
    coeffs: [f32; NOTES],
    s1: [f32; NOTES],
    s2: [f32; NOTES],
    count: usize,
    dec: usize,
    acc: f32,
    lp: f32,
    chroma: [f32; 12],
}

impl KeyDetector {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate / DECIMATE as f32;
        let mut coeffs = [0.0; NOTES];
        for (i, c) in coeffs.iter_mut().enumerate() {
            let hz = 440.0 * ((LOW_NOTE + i as i32 - 69) as f32 / 12.0).exp2();
            *c = 2.0 * (std::f32::consts::TAU * hz / sr).cos();
        }
        Self {
            coeffs,
            s1: [0.0; NOTES],
            s2: [0.0; NOTES],
            count: 0,
            dec: 0,
            acc: 0.0,
            lp: 0.0,
            chroma: [0.0; 12],
        }
    }

    /// Feeds one mono music sample; cheap (one filter bank step every 4 samples).
    #[inline]
    pub fn push(&mut self, x: f32) {
        self.lp += 0.3 * (x - self.lp);
        self.acc += self.lp;
        self.dec += 1;
        if self.dec < DECIMATE {
            return;
        }
        let v = self.acc / DECIMATE as f32;
        self.acc = 0.0;
        self.dec = 0;
        for i in 0..NOTES {
            let s = v + self.coeffs[i] * self.s1[i] - self.s2[i];
            self.s2[i] = self.s1[i];
            self.s1[i] = s;
        }
        self.count += 1;
        if self.count == BLOCK {
            // Slow leaky integration over ~20 blocks (~7 s at 48 kHz).
            for c in &mut self.chroma {
                *c *= 0.95;
            }
            for i in 0..NOTES {
                let p = self.s1[i] * self.s1[i] + self.s2[i] * self.s2[i]
                    - self.coeffs[i] * self.s1[i] * self.s2[i];
                let class = (LOW_NOTE as usize + i) % 12;
                self.chroma[class] += p.max(0.0).sqrt();
                self.s1[i] = 0.0;
                self.s2[i] = 0.0;
            }
            self.count = 0;
        }
    }

    pub fn chroma(&self) -> [f32; 12] {
        self.chroma
    }

    pub fn guess(&self) -> Option<KeyGuess> {
        guess_from_chroma(&self.chroma)
    }
}

fn pearson(a: &[f32; 12], b: &[f32; 12], rot: usize) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let x = a[(i + rot) % 12] - ma;
        let y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 {
        0.0
    } else {
        num / (da * db).sqrt()
    }
}

pub fn guess_from_chroma(chroma: &[f32; 12]) -> Option<KeyGuess> {
    if chroma.iter().sum::<f32>() <= 1e-6 {
        return None;
    }
    let mut best = KeyGuess {
        key: 0,
        scale: Scale::Major,
        confidence: -1.0,
    };
    for k in 0..12 {
        for (profile, scale) in [(&KS_MAJOR, Scale::Major), (&KS_MINOR, Scale::Minor)] {
            let r = pearson(chroma, profile, k);
            if r > best.confidence {
                best = KeyGuess {
                    key: k as u8,
                    scale,
                    confidence: r,
                };
            }
        }
    }
    Some(best)
}

/// Lowers the music while the voice is present.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ducker {
    gain: f32,
    att: f32,
    rel: f32,
}

impl Ducker {
    pub fn set(&mut self, release_ms: f32, sr: f32) {
        self.att = coef_ms(30.0, sr);
        self.rel = coef_ms(release_ms, sr);
        if self.gain == 0.0 {
            self.gain = 1.0;
        }
    }
    /// `singing` from the voice detector; returns the gain for this sample.
    #[inline]
    pub fn run(&mut self, singing: bool, depth: f32) -> f32 {
        let target = if singing { depth } else { 1.0 };
        let c = if target < self.gain {
            self.att
        } else {
            self.rel
        };
        self.gain = target + c * (self.gain - target);
        self.gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minor_chord_progression_is_detected() {
        let sr = 48_000.0;
        let mut d = KeyDetector::new(sr);
        // Am - F - C - G triads, 2 s each, twice.
        let chords: [[i32; 3]; 4] = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
        let mut t = 0usize;
        for _ in 0..2 {
            for ch in chords {
                for _ in 0..(sr as usize * 2) {
                    let time = t as f32 / sr;
                    let x: f32 = ch
                        .iter()
                        .map(|&n| {
                            (std::f32::consts::TAU * 440.0 * ((n - 69) as f32 / 12.0).exp2() * time)
                                .sin()
                        })
                        .sum();
                    d.push(x * 0.2);
                    t += 1;
                }
            }
        }
        let g = d.guess().expect("key");
        // A minor and its relative C major share the notes; accept either.
        let ok = (g.key == 9 && g.scale == Scale::Minor) || (g.key == 0 && g.scale == Scale::Major);
        assert!(
            ok,
            "{g:?} chroma {:?}",
            d.chroma().map(|v| (v * 10.0).round() / 10.0)
        );
    }

    #[test]
    fn ducker_moves_towards_depth() {
        let mut d = Ducker::default();
        d.set(200.0, 48_000.0);
        let mut g = 1.0;
        for _ in 0..9600 {
            g = d.run(true, 0.4);
        }
        assert!((g - 0.4).abs() < 0.01);
    }
}
