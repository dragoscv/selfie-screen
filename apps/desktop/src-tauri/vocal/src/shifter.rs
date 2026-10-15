//! Period-synchronous splice shifter (classic low-latency "autotune").
//!
//! A read pointer moves through a short delay line at `ratio` samples per
//! input sample. When it gets too close to the writer (pitch up) or too far
//! behind (pitch down) it jumps by one detected period and crossfades from
//! the old position, so the splice lands on the same point of the waveform.
//! Latency is the delay line length: a few ms plus at most one period.

/// 32768 samples = 170 ms at 192 kHz: room for a period of 50 Hz plus the window.
const SIZE: usize = 32_768;
const MASK: usize = SIZE - 1;

pub struct Splice {
    buf: Box<[f32]>,
    w: usize,
    /// Read position, in samples behind the writer.
    delay: f32,
    /// Crossfade state: old delay and progress 0..1.
    fade_from: f32,
    fade: f32,
    fade_step: f32,
    base_delay: f32,
}

impl Splice {
    pub fn new(sample_rate: f32) -> Self {
        let base = (sample_rate * 0.0006).max(8.0);
        Self {
            buf: vec![0.0; SIZE].into_boxed_slice(),
            w: 0,
            delay: base + 4.0,
            fade_from: 0.0,
            fade: 1.0,
            fade_step: 0.0,
            base_delay: base,
        }
    }

    /// Current latency in samples.
    pub fn latency(&self) -> f32 {
        self.delay
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.delay = self.base_delay + 4.0;
        self.fade = 1.0;
    }

    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let pos = self.w as f32 - delay;
        let i = pos.floor();
        let t = pos - i;
        let i = i as isize;
        let at = |k: isize| self.buf[(i + k).rem_euclid(SIZE as isize) as usize & MASK];
        // 4-point Hermite.
        let (xm1, x0, x1, x2) = (at(-1), at(0), at(1), at(2));
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * t + c2) * t + c1) * t + x0
    }

    /// One sample. `period` = detected input period in samples (any sane
    /// value when unvoiced, e.g. 10 ms).
    #[inline]
    pub fn process(&mut self, x: f32, ratio: f32, period: f32) -> f32 {
        self.buf[self.w & MASK] = x;
        self.w = self.w.wrapping_add(1);
        let ratio = ratio.clamp(0.5, 2.0);
        let period = period.clamp(16.0, (SIZE / 4) as f32);
        let step = 1.0 - ratio; // change of delay per sample
        let xf = (period * 0.5).clamp(32.0, 480.0);

        if self.fade >= 1.0 {
            let lo = self.base_delay + (ratio - 1.0).max(0.0) * xf + 2.0;
            let hi = lo + period + (1.0 - ratio).max(0.0) * xf;
            if self.delay < lo {
                self.start_fade(period, xf);
            } else if self.delay > hi {
                self.start_fade(-period, xf);
            }
        }
        let wet = self.read(self.delay);
        let out = if self.fade < 1.0 {
            let old = self.read(self.fade_from);
            self.fade_from += step;
            let g = self.fade;
            self.fade = (self.fade + self.fade_step).min(1.0);
            // Equal-power-ish: the two segments are period aligned, so linear is fine.
            old * (1.0 - g) + wet * g
        } else {
            wet
        };
        self.delay = (self.delay + step).clamp(1.0, (SIZE - 4) as f32);
        out
    }

    fn start_fade(&mut self, jump: f32, xf: f32) {
        let next = self.delay + jump;
        if next < 1.0 || next > (SIZE - 4) as f32 {
            return;
        }
        self.fade_from = self.delay;
        self.delay = next;
        self.fade = 0.0;
        self.fade_step = 1.0 / xf;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pitch::Detector;

    pub fn tone(hz: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                0.5 * (std::f32::consts::TAU * hz * t).sin()
                    + 0.25 * (std::f32::consts::TAU * 2.0 * hz * t).sin()
            })
            .collect()
    }

    pub fn measure(signal: &[f32], sr: f32) -> f32 {
        let mut d = Detector::new(sr);
        let mut last = 0.0;
        for &x in signal {
            if let Some(Some(e)) = d.push(x) {
                last = e.hz;
            }
        }
        last
    }

    #[test]
    fn shifts_by_the_ratio_with_low_latency() {
        let sr = 48_000.0;
        for (hz, semis) in [
            (220.0f32, 1.0f32),
            (220.0, -2.0),
            (150.0, 0.5),
            (330.0, -0.7),
        ] {
            let ratio = (semis / 12.0).exp2();
            let mut s = Splice::new(sr);
            let input = tone(hz, sr, 24_000);
            let mut max_latency = 0.0f32;
            let out: Vec<f32> = input
                .iter()
                .map(|&x| {
                    let y = s.process(x, ratio, sr / hz);
                    max_latency = max_latency.max(s.latency());
                    y
                })
                .collect();
            let got = measure(&out[4_800..], sr);
            let cents = 1200.0 * (got / (hz * ratio)).log2();
            assert!(
                cents.abs() < 8.0,
                "{hz} Hz {semis} st -> {got} Hz ({cents} c)"
            );
            let ms = max_latency / sr * 1000.0;
            assert!(ms < 1.5 + 1000.0 / hz + 6.0, "latency {ms} ms");
        }
    }

    #[test]
    fn unity_ratio_is_a_short_delay() {
        let sr = 48_000.0;
        let mut s = Splice::new(sr);
        for x in tone(200.0, sr, 4800) {
            s.process(x, 1.0, 240.0);
        }
        assert!(s.latency() / sr * 1000.0 < 2.0);
    }
}
