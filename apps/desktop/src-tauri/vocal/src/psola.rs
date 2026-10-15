//! Streaming TD-PSOLA: two-period Hann grains taken at analysis marks
//! (spaced one input period apart, snapped to waveform peaks) and
//! overlap-added at the output period. Formants stay put; `formant` resamples
//! each grain to move them on purpose.
//!
//! Latency is fixed while singing (about two periods of the lowest note of
//! the phrase) and only re-sized during silence, so it never glitches.

const SIZE: usize = 65_536;
const MASK: usize = SIZE - 1;
const MARKS: usize = 64;

pub struct Psola {
    sr: f32,
    input: Box<[f32]>,
    ola: Box<[f32]>,
    /// Samples written so far (absolute input time).
    n: u64,
    /// Fixed output latency in samples.
    latency: u64,
    marks: [u64; MARKS],
    mark_head: usize,
    mark_count: usize,
    next_mark_search: u64,
    next_synth: f64,
    silent: u32,
    phrase_max_period: f32,
}

impl Psola {
    pub fn new(sample_rate: f32) -> Self {
        let latency = (2.2 * sample_rate / 150.0) as u64;
        Self {
            sr: sample_rate,
            input: vec![0.0; SIZE].into_boxed_slice(),
            ola: vec![0.0; SIZE].into_boxed_slice(),
            n: 0,
            latency,
            marks: [0; MARKS],
            mark_head: 0,
            mark_count: 0,
            next_mark_search: 0,
            next_synth: 0.0,
            silent: 0,
            phrase_max_period: 0.0,
        }
    }

    pub fn latency(&self) -> f32 {
        self.latency as f32
    }

    #[inline]
    fn at(&self, t: f64) -> f32 {
        let i = t.floor();
        let f = (t - i) as f32;
        let i = i as u64;
        let a = self.input[(i as usize) & MASK];
        let b = self.input[(i.wrapping_add(1) as usize) & MASK];
        a + (b - a) * f
    }

    fn push_mark(&mut self, m: u64) {
        self.marks[self.mark_head] = m;
        self.mark_head = (self.mark_head + 1) % MARKS;
        self.mark_count = (self.mark_count + 1).min(MARKS);
    }

    /// Latest analysis mark at or before `t`.
    fn mark_before(&self, t: u64) -> Option<u64> {
        (0..self.mark_count)
            .map(|k| self.marks[(self.mark_head + MARKS - 1 - k) % MARKS])
            .find(|&m| m <= t)
    }

    /// One sample. `voiced` = the detector trusts `period` (input samples).
    #[inline]
    pub fn process(&mut self, x: f32, ratio: f32, period: f32, voiced: bool, formant: f32) -> f32 {
        let ratio = ratio.clamp(0.5, 2.0) as f64;
        let formant = formant.clamp(0.7, 1.4);
        let period = if voiced {
            period.clamp(24.0, 0.45 * self.latency as f32)
        } else {
            self.sr * 0.006
        };
        self.input[(self.n as usize) & MASK] = x;
        self.n += 1;

        // Re-size the latency only after 100 ms of silence.
        if voiced {
            self.silent = 0;
            self.phrase_max_period = self.phrase_max_period.max(period);
        } else {
            self.silent = self.silent.saturating_add(1);
            if self.silent == (self.sr * 0.1) as u32 && self.phrase_max_period > 0.0 {
                let want =
                    ((2.0 + formant.max(1.0)) * self.phrase_max_period.min(self.sr / 70.0)) as u64;
                let want = want.clamp((self.sr * 0.004) as u64, (SIZE / 4) as u64);
                self.latency = want;
                self.phrase_max_period = 0.0;
                self.ola.fill(0.0);
                self.next_synth = 0.0;
            }
        }

        // Analysis marks: peak of |x| in [last + 0.75P, last + 1.25P] once available.
        let p = period as u64;
        let last = self.mark_before(u64::MAX).unwrap_or(0);
        let search_end = last + p + p / 4;
        if self.n > search_end && self.n >= self.next_mark_search {
            let start = (last + p - p / 4).max(self.n.saturating_sub(2 * p));
            let mut best = start;
            let mut best_v = 0.0f32;
            for t in start..search_end.min(self.n) {
                let v = self.input[(t as usize) & MASK].abs();
                if v > best_v {
                    best_v = v;
                    best = t;
                }
            }
            self.push_mark(best);
            self.next_mark_search = best + p / 2;
        }

        // Output time (input-time coordinates).
        let tau = self.n.saturating_sub(self.latency);
        let half = period as f64; // grain half-length in output samples
        if self.next_synth < tau as f64 {
            self.next_synth = tau as f64 + half;
        }
        let out_period = (period as f64 / ratio).max(16.0);
        while self.next_synth - half <= tau as f64 {
            let s = self.next_synth;
            let src_half = half * formant as f64;
            let newest = self.n.saturating_sub(src_half as u64 + 2);
            let a = self.mark_before((s as u64).min(newest)).unwrap_or(newest) as f64;
            let gain = (out_period / half).min(1.0) as f32;
            let len = (2.0 * half) as i64;
            for k in 0..len {
                let off = k as f64 - half;
                let w = 0.5 - 0.5 * (std::f64::consts::TAU * k as f64 / len as f64).cos();
                let v = self.at(a + off * formant as f64);
                let dst = (s + off).round() as i64;
                if dst >= tau as i64 {
                    self.ola[(dst as usize) & MASK] += v * w as f32 * gain;
                }
            }
            self.next_synth += out_period;
        }
        let slot = (tau as usize) & MASK;
        let y = self.ola[slot];
        self.ola[slot] = 0.0;
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shifter::tests::{measure, tone};

    #[test]
    fn psola_shifts_pitch() {
        let sr = 48_000.0;
        for (hz, semis) in [(220.0f32, 2.0f32), (220.0, -3.0), (300.0, 1.0)] {
            let ratio = (semis / 12.0).exp2();
            let mut p = Psola::new(sr);
            let out: Vec<f32> = tone(hz, sr, 24_000)
                .into_iter()
                .map(|x| p.process(x, ratio, sr / hz, true, 1.0))
                .collect();
            let got = measure(&out[6_000..], sr);
            let cents = 1200.0 * (got / (hz * ratio)).log2();
            assert!(
                cents.abs() < 10.0,
                "{hz} Hz {semis} st -> {got} Hz ({cents} c)"
            );
            assert!(p.latency() / sr * 1000.0 < 20.0);
        }
    }
}
