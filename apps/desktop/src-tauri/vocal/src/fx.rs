//! Vocal chain building blocks. All state is fixed-size; coefficients are
//! recomputed only when parameters change (`set_*`), never per sample.

use crate::params::{Band, BandKind};

#[inline]
pub fn db(x: f32) -> f32 {
    (x / 20.0 * std::f32::consts::LN_10).exp()
}

#[inline]
pub fn to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

#[inline]
pub fn coef_ms(ms: f32, sr: f32) -> f32 {
    if ms <= 0.0 {
        0.0
    } else {
        (-1.0 / (ms * 0.001 * sr)).exp()
    }
}

use coef_ms as coef;

/* ---------------- biquad (RBJ cookbook, TDF-II) ---------------- */

#[derive(Debug, Clone, Copy, Default)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn set(&mut self, b: [f64; 3], a: [f64; 3]) {
        let a0 = a[0];
        self.b0 = (b[0] / a0) as f32;
        self.b1 = (b[1] / a0) as f32;
        self.b2 = (b[2] / a0) as f32;
        self.a1 = (a[1] / a0) as f32;
        self.a2 = (a[2] / a0) as f32;
    }

    fn w(hz: f32, sr: f32, q: f32) -> (f64, f64, f64) {
        let w0 = std::f64::consts::TAU * f64::from(hz.clamp(10.0, sr * 0.45)) / f64::from(sr);
        let alpha = w0.sin() / (2.0 * f64::from(q.max(0.1)));
        (w0.cos(), alpha, w0)
    }

    pub fn highpass(&mut self, hz: f32, q: f32, sr: f32) {
        let (c, al, _) = Self::w(hz, sr, q);
        self.set(
            [(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0],
            [1.0 + al, -2.0 * c, 1.0 - al],
        );
    }

    pub fn bandpass(&mut self, hz: f32, q: f32, sr: f32) {
        let (c, al, _) = Self::w(hz, sr, q);
        self.set([al, 0.0, -al], [1.0 + al, -2.0 * c, 1.0 - al]);
    }

    pub fn band(&mut self, b: &Band, sr: f32) {
        let a = 10f64.powf(f64::from(b.gain_db) / 40.0);
        let (c, al, _) = Self::w(b.hz, sr, b.q);
        match b.kind {
            BandKind::Peak => self.set(
                [1.0 + al * a, -2.0 * c, 1.0 - al * a],
                [1.0 + al / a, -2.0 * c, 1.0 - al / a],
            ),
            BandKind::LowShelf => {
                let s = 2.0 * a.sqrt() * al;
                self.set(
                    [
                        a * ((a + 1.0) - (a - 1.0) * c + s),
                        2.0 * a * ((a - 1.0) - (a + 1.0) * c),
                        a * ((a + 1.0) - (a - 1.0) * c - s),
                    ],
                    [
                        (a + 1.0) + (a - 1.0) * c + s,
                        -2.0 * ((a - 1.0) + (a + 1.0) * c),
                        (a + 1.0) + (a - 1.0) * c - s,
                    ],
                );
            }
            BandKind::HighShelf => {
                let s = 2.0 * a.sqrt() * al;
                self.set(
                    [
                        a * ((a + 1.0) + (a - 1.0) * c + s),
                        -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
                        a * ((a + 1.0) + (a - 1.0) * c - s),
                    ],
                    [
                        (a + 1.0) - (a - 1.0) * c + s,
                        2.0 * ((a - 1.0) - (a + 1.0) * c),
                        (a + 1.0) - (a - 1.0) * c - s,
                    ],
                );
            }
        }
    }

    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    /// Magnitude response at `hz`, for the EQ curve in the UI.
    pub fn magnitude(&self, hz: f32, sr: f32) -> f32 {
        let w = std::f32::consts::TAU * hz / sr;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }
}

/* ---------------- dynamics ---------------- */

/// Peak envelope follower with separate attack/release.
#[derive(Debug, Clone, Copy, Default)]
pub struct Env {
    v: f32,
    att: f32,
    rel: f32,
}

impl Env {
    pub fn set(&mut self, attack_ms: f32, release_ms: f32, sr: f32) {
        self.att = coef(attack_ms, sr);
        self.rel = coef(release_ms, sr);
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let a = x.abs();
        let c = if a > self.v { self.att } else { self.rel };
        self.v = a + c * (self.v - a);
        self.v
    }
    pub fn value(&self) -> f32 {
        self.v
    }
}

/// Downward expander gate: closes smoothly below the threshold.
#[derive(Debug, Clone, Copy, Default)]
pub struct Gate {
    env: Env,
    gain: f32,
    threshold: f32,
    smooth: f32,
}

impl Gate {
    pub fn set(&mut self, threshold_db: f32, sr: f32) {
        self.env.set(1.0, 80.0, sr);
        self.threshold = db(threshold_db);
        self.smooth = coef(5.0, sr);
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let e = self.env.run(x);
        let target = if e >= self.threshold {
            1.0
        } else {
            (e / self.threshold).powi(2)
        };
        self.gain = target + self.smooth * (self.gain - target);
        x * self.gain
    }
}

/// Feed-forward compressor with soft knee; reports gain reduction in dB.
#[derive(Debug, Clone, Copy, Default)]
pub struct Compressor {
    env: Env,
    threshold_db: f32,
    ratio: f32,
    makeup: f32,
    pub reduction_db: f32,
}

impl Compressor {
    pub fn set(
        &mut self,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
        sr: f32,
    ) {
        self.env.set(attack_ms, release_ms, sr);
        self.threshold_db = threshold_db;
        self.ratio = ratio.max(1.0);
        self.makeup = db(makeup_db);
    }
    #[inline]
    pub fn gain_for(&mut self, detector: f32) -> f32 {
        let lvl = to_db(self.env.run(detector));
        let knee = 6.0;
        let over = lvl - self.threshold_db;
        let red = if over <= -knee / 2.0 {
            0.0
        } else if over >= knee / 2.0 {
            over * (1.0 - 1.0 / self.ratio)
        } else {
            let o = over + knee / 2.0;
            (1.0 - 1.0 / self.ratio) * o * o / (2.0 * knee)
        };
        self.reduction_db = red;
        db(-red) * self.makeup
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        x * self.gain_for(x)
    }
}

/// Split-band de-esser: compresses only the sibilant band.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeEsser {
    band: Biquad,
    comp: Compressor,
}

impl DeEsser {
    pub fn set(&mut self, hz: f32, threshold_db: f32, sr: f32) {
        self.band.bandpass(hz, 1.4, sr);
        self.comp.set(threshold_db, 6.0, 0.5, 60.0, 0.0, sr);
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let s = self.band.run(x);
        let g = self.comp.gain_for(s);
        x - s + s * g
    }
    pub fn reduction_db(&self) -> f32 {
        self.comp.reduction_db
    }
}

/// Look-ahead-free brickwall-ish limiter (fast attack, smooth release).
#[derive(Debug, Clone, Copy, Default)]
pub struct Limiter {
    ceiling: f32,
    gain: f32,
    rel: f32,
}

impl Limiter {
    pub fn set(&mut self, ceiling_db: f32, sr: f32) {
        self.ceiling = db(ceiling_db);
        self.rel = coef(80.0, sr);
        if self.gain == 0.0 {
            self.gain = 1.0;
        }
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let (y, _) = self.run_stereo(x, 0.0);
        y
    }
    /// Stereo-linked: one gain from the louder channel keeps the image stable.
    #[inline]
    pub fn run_stereo(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = l.abs().max(r.abs());
        let need = if peak * self.gain > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };
        self.gain = if need < self.gain {
            need
        } else {
            need + self.rel * (self.gain - need)
        };
        let c = self.ceiling;
        ((l * self.gain).clamp(-c, c), (r * self.gain).clamp(-c, c))
    }
}

/* ---------------- reverb (Freeverb topology, stereo) ---------------- */

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
const SPREAD: usize = 23;
/// Freeverb's longest comb (1617 + spread at 44.1 kHz) scaled to 192 kHz.
const MAX_LINE: usize = 8192;

struct Comb {
    buf: Box<[f32]>,
    len: usize,
    i: usize,
    store: f32,
}

impl Comb {
    #[inline]
    fn run(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let y = self.buf[self.i];
        self.store = y * (1.0 - damp) + self.store * damp;
        self.buf[self.i] = x + self.store * feedback;
        self.i = (self.i + 1) % self.len;
        y
    }
}

struct Allpass {
    buf: Box<[f32]>,
    len: usize,
    i: usize,
}

impl Allpass {
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let b = self.buf[self.i];
        self.buf[self.i] = x + b * 0.5;
        self.i = (self.i + 1) % self.len;
        b - x
    }
}

pub struct Reverb {
    combs: [Vec<Comb>; 2],
    allpasses: [Vec<Allpass>; 2],
    feedback: f32,
    damp: f32,
}

impl Reverb {
    pub fn new(sr: f32) -> Box<Self> {
        let k = sr / 44_100.0;
        let scale =
            |n: usize, side: usize| (((n + side * SPREAD) as f32 * k) as usize).clamp(8, MAX_LINE);
        let comb = |n, s| {
            let len = scale(n, s);
            Comb {
                buf: vec![0.0; len].into_boxed_slice(),
                len,
                i: 0,
                store: 0.0,
            }
        };
        let ap = |n, s| {
            let len = scale(n, s);
            Allpass {
                buf: vec![0.0; len].into_boxed_slice(),
                len,
                i: 0,
            }
        };
        Box::new(Self {
            combs: [0, 1].map(|s| COMBS.iter().map(|&n| comb(n, s)).collect()),
            allpasses: [0, 1].map(|s| ALLPASSES.iter().map(|&n| ap(n, s)).collect()),
            feedback: 0.84,
            damp: 0.2,
        })
    }
    pub fn set(&mut self, size: f32, damp: f32) {
        self.feedback = 0.7 + 0.28 * size.clamp(0.0, 1.0);
        self.damp = 0.4 * damp.clamp(0.0, 1.0);
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> (f32, f32) {
        let input = x * 0.015;
        let mut out = [0.0f32; 2];
        for (side, o) in out.iter_mut().enumerate() {
            let mut acc = 0.0;
            for c in &mut self.combs[side] {
                acc += c.run(input, self.feedback, self.damp);
            }
            for a in &mut self.allpasses[side] {
                acc = a.run(acc);
            }
            *o = acc;
        }
        (out[0], out[1])
    }
}

/* ---------------- delay ---------------- */

const DELAY_MAX: usize = 288_000; // 1.5 s at 192 kHz

pub struct Delay {
    buf: Box<[f32]>,
    i: usize,
    len: usize,
    feedback: f32,
    tone: Biquad,
}

impl Delay {
    pub fn new() -> Self {
        Self {
            buf: vec![0.0; DELAY_MAX].into_boxed_slice(),
            i: 0,
            len: 1,
            feedback: 0.0,
            tone: Biquad::default(),
        }
    }
    pub fn set(&mut self, ms: f32, feedback: f32, sr: f32) {
        self.len = ((ms * 0.001 * sr) as usize).clamp(1, DELAY_MAX - 1);
        self.feedback = feedback.clamp(0.0, 0.9);
        self.tone.band(
            &Band {
                on: true,
                kind: BandKind::HighShelf,
                hz: 4000.0,
                gain_db: -6.0,
                q: 0.7,
            },
            sr,
        );
    }
    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let r = (self.i + DELAY_MAX - self.len) % DELAY_MAX;
        let y = self.buf[r];
        self.buf[self.i] = x + self.tone.run(y) * self.feedback;
        self.i = (self.i + 1) % DELAY_MAX;
        y
    }
}

impl Default for Delay {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_band_gain_at_centre() {
        let mut b = Biquad::default();
        b.band(
            &Band {
                on: true,
                kind: BandKind::Peak,
                hz: 1000.0,
                gain_db: 6.0,
                q: 1.0,
            },
            48_000.0,
        );
        assert!((to_db(b.magnitude(1000.0, 48_000.0)) - 6.0).abs() < 0.05);
        assert!(to_db(b.magnitude(100.0, 48_000.0)).abs() < 0.5);
    }

    #[test]
    fn highpass_cuts_lows() {
        let mut b = Biquad::default();
        b.highpass(100.0, 0.707, 48_000.0);
        assert!(to_db(b.magnitude(30.0, 48_000.0)) < -15.0);
        assert!(to_db(b.magnitude(1000.0, 48_000.0)).abs() < 0.2);
    }

    #[test]
    fn compressor_reduces_loud_signals() {
        let mut c = Compressor::default();
        c.set(-20.0, 4.0, 1.0, 50.0, 0.0, 48_000.0);
        let mut y = 0.0;
        for _ in 0..4800 {
            y = c.run(0.5); // -6 dBFS, 14 dB over
        }
        assert!((c.reduction_db - 10.5).abs() < 1.0, "{}", c.reduction_db);
        assert!(y < 0.5);
    }

    #[test]
    fn limiter_holds_the_ceiling() {
        let mut l = Limiter::default();
        l.set(-1.0, 48_000.0);
        for i in 0..4800 {
            let x = 2.0 * ((i as f32) * 0.05).sin();
            assert!(l.run(x).abs() <= db(-1.0) + 1e-6);
        }
    }

    #[test]
    fn reverb_and_delay_are_stable() {
        let mut r = Reverb::new(48_000.0);
        r.set(1.0, 0.0);
        let mut d = Delay::new();
        d.set(100.0, 0.9, 48_000.0);
        let mut peak = 0.0f32;
        for i in 0..96_000 {
            let x = if i == 0 { 1.0 } else { 0.0 };
            let (a, b) = r.run(x);
            peak = peak.max(a.abs()).max(b.abs()).max(d.run(x).abs());
        }
        assert!(peak.is_finite() && peak < 4.0, "{peak}");
    }
}
