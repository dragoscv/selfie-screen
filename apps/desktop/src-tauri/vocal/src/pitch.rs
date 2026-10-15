//! McLeod Pitch Method (NSDF via FFT) on a sliding window of past input.
//!
//! The detector never delays audio: it looks at the last `window` samples
//! every `hop` samples, so the estimate is at most half a window old. All
//! buffers are allocated in [`Detector::new`].

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    pub hz: f32,
    /// NSDF peak height, 0..1 (how periodic the window is).
    pub clarity: f32,
    pub rms: f32,
}

pub struct Detector {
    sr: f32,
    /// Input samples averaged into one analysis sample (176.4 kHz → 4).
    dec: usize,
    dec_n: usize,
    dec_acc: f32,
    window: usize,
    hop: usize,
    ring: Vec<f32>,
    pos: usize,
    since: usize,
    frame: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    acf: Vec<f32>,
    nsdf: Vec<f32>,
    scratch_f: Vec<Complex<f32>>,
    scratch_i: Vec<Complex<f32>>,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    min_hz: f32,
    max_hz: f32,
    /// Peak threshold relative to the highest NSDF peak (MPM "k").
    k: f32,
    last: Option<Estimate>,
    history: [f32; 3],
    hist_len: usize,
}

impl Detector {
    /// Analysis runs at ~44–48 kHz whatever the device rate (Voicemeeter can
    /// run at 96/176.4/192 kHz); 2048 samples = ~43 ms = two periods of 47 Hz.
    pub fn new(sample_rate: f32) -> Self {
        let dec = (sample_rate / 44_100.0).floor().max(1.0) as usize;
        let sample_rate = sample_rate / dec as f32;
        let window = 2048;
        let n = window * 2;
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        Self {
            sr: sample_rate,
            dec,
            dec_n: 0,
            dec_acc: 0.0,
            window,
            hop: (sample_rate / 375.0).round().max(32.0) as usize,
            ring: vec![0.0; window],
            pos: 0,
            since: 0,
            frame: fwd.make_input_vec(),
            spectrum: fwd.make_output_vec(),
            acf: inv.make_output_vec(),
            nsdf: vec![0.0; window],
            scratch_f: fwd.make_scratch_vec(),
            scratch_i: inv.make_scratch_vec(),
            fwd,
            inv,
            min_hz: 70.0,
            max_hz: 1100.0,
            k: 0.88,
            last: None,
            history: [0.0; 3],
            hist_len: 0,
        }
    }

    pub fn set_range(&mut self, min_hz: f32, max_hz: f32) {
        let lowest = 2.0 * self.sr / self.window as f32;
        self.min_hz = min_hz.max(lowest);
        self.max_hz = max_hz.clamp(self.min_hz * 2.0, self.sr / 4.0);
    }

    /// Hop in INPUT samples (what the caller counts).
    pub fn hop(&self) -> usize {
        self.hop * self.dec
    }

    pub fn last(&self) -> Option<Estimate> {
        self.last
    }

    /// Feeds one sample; returns `Some` right after a new analysis.
    #[inline]
    pub fn push(&mut self, x: f32) -> Option<Option<Estimate>> {
        if self.dec > 1 {
            self.dec_acc += x;
            self.dec_n += 1;
            if self.dec_n < self.dec {
                return None;
            }
            let x = self.dec_acc / self.dec as f32;
            self.dec_acc = 0.0;
            self.dec_n = 0;
            return self.push_analysis(x);
        }
        self.push_analysis(x)
    }

    #[inline]
    fn push_analysis(&mut self, x: f32) -> Option<Option<Estimate>> {
        self.ring[self.pos] = x;
        self.pos = (self.pos + 1) % self.window;
        self.since += 1;
        if self.since < self.hop {
            return None;
        }
        self.since = 0;
        let est = self.analyse();
        self.last = est;
        Some(est)
    }

    fn analyse(&mut self) -> Option<Estimate> {
        let w = self.window;
        let mut energy = 0.0f32;
        for i in 0..w {
            let v = self.ring[(self.pos + i) % w];
            self.frame[i] = v;
            energy += v * v;
        }
        let rms = (energy / w as f32).sqrt();
        if rms < 1e-4 {
            self.hist_len = 0;
            return None;
        }
        for v in &mut self.frame[w..] {
            *v = 0.0;
        }
        // Keep a copy of the time-domain frame in nsdf for m'(tau): fwd mutates frame.
        self.nsdf.copy_from_slice(&self.frame[..w]);
        self.fwd
            .process_with_scratch(&mut self.frame, &mut self.spectrum, &mut self.scratch_f)
            .ok()?;
        for c in &mut self.spectrum {
            *c = Complex::new(c.norm_sqr(), 0.0);
        }
        self.inv
            .process_with_scratch(&mut self.spectrum, &mut self.acf, &mut self.scratch_i)
            .ok()?;
        // acf is scaled by n; only ratios matter after normalising by m.
        let tau_min = (self.sr / self.max_hz).floor().max(2.0) as usize;
        let tau_max = ((self.sr / self.min_hz).ceil() as usize).min(w - 2);
        let x = &self.nsdf; // time-domain copy
        let mut m = 2.0 * energy;
        let scale = 1.0 / (self.frame.len() as f32);
        // Reuse `frame` as the NSDF output to avoid another buffer.
        let out = &mut self.frame;
        out[0] = 1.0;
        for tau in 1..=tau_max + 1 {
            m -= x[tau - 1] * x[tau - 1] + x[w - tau] * x[w - tau];
            out[tau] = if m > 1e-9 {
                2.0 * self.acf[tau] * scale / m
            } else {
                0.0
            };
        }
        // MPM peak picking: highest point between each positive-going zero
        // crossing and the next negative-going one.
        let mut peaks: [(usize, f32); 32] = [(0, 0.0); 32];
        let mut count = 0usize;
        let mut tau = 1;
        while tau < tau_max && out[tau] > 0.0 {
            tau += 1;
        }
        let mut best_peak = 0.0f32;
        while tau < tau_max && count < peaks.len() {
            while tau < tau_max && out[tau] <= 0.0 {
                tau += 1;
            }
            let mut pk = tau;
            while tau < tau_max && out[tau] > 0.0 {
                if out[tau] > out[pk] {
                    pk = tau;
                }
                tau += 1;
            }
            // A maximum sitting on the search edge is the range clamp, not a period.
            if pk > tau_min
                && pk + 1 < tau_max
                && out[pk] > 0.0
                && out[pk] >= out[pk - 1]
                && out[pk] >= out[pk + 1]
            {
                peaks[count] = (pk, out[pk]);
                count += 1;
                best_peak = best_peak.max(out[pk]);
            }
        }
        if count == 0 {
            self.hist_len = 0;
            return None;
        }
        let threshold = best_peak * self.k;
        let (pk, _) = *peaks[..count].iter().find(|(_, v)| *v >= threshold)?;
        // Parabolic interpolation.
        let (a, b, c) = (out[pk - 1], out[pk], out[pk + 1]);
        let denom = a - 2.0 * b + c;
        let shift = if denom.abs() > 1e-9 {
            0.5 * (a - c) / denom
        } else {
            0.0
        };
        let period = pk as f32 + shift.clamp(-0.5, 0.5);
        let clarity = (b - 0.25 * (a - c) * shift).min(1.0);
        let hz = self.sr / period;
        Some(Estimate {
            hz: self.smooth(hz),
            clarity,
            rms,
        })
    }

    /// Median of the last three estimates removes single-frame octave slips.
    fn smooth(&mut self, hz: f32) -> f32 {
        self.history.rotate_left(1);
        self.history[2] = hz;
        self.hist_len = (self.hist_len + 1).min(3);
        if self.hist_len < 3 {
            return hz;
        }
        let [a, b, c] = self.history;
        a.max(b).min(a.min(b).max(c))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(hz: f32, sr: f32) -> Option<Estimate> {
        let mut d = Detector::new(sr);
        d.set_range(70.0, 1100.0);
        let mut last = None;
        for i in 0..(sr as usize / 4) {
            let t = i as f32 / sr;
            // Voice-like: fundamental + harmonics.
            let x = 0.5 * (std::f32::consts::TAU * hz * t).sin()
                + 0.3 * (std::f32::consts::TAU * 2.0 * hz * t).sin()
                + 0.2 * (std::f32::consts::TAU * 3.0 * hz * t).sin();
            if let Some(e) = d.push(x) {
                last = e;
            }
        }
        last
    }

    #[test]
    fn finds_sung_pitches_within_5_cents() {
        for sr in [44_100.0, 48_000.0, 96_000.0, 176_400.0] {
            for hz in [82.4, 110.0, 196.0, 261.6, 440.0, 880.0] {
                let est = detect(hz, sr).expect("pitch");
                let cents = 1200.0 * (est.hz / hz).log2();
                assert!(
                    cents.abs() < 5.0,
                    "{sr}: {hz} Hz -> {} Hz ({cents} c)",
                    est.hz
                );
                assert!(est.clarity > 0.9);
            }
        }
    }

    #[test]
    fn noise_and_silence_are_unvoiced_or_unclear() {
        assert!(detect(0.0, 48_000.0).is_none());
        let mut d = Detector::new(48_000.0);
        let mut seed = 1u32;
        let mut clear = 0;
        for _ in 0..24_000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = (seed >> 9) as f32 / 8_388_608.0 - 1.0;
            if let Some(Some(e)) = d.push(x * 0.3)
                && e.clarity > 0.8
            {
                clear += 1;
            }
        }
        assert!(clear < 5, "noise judged periodic {clear} times");
    }
}
