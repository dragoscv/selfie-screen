//! Streaming TD-PSOLA: two-period Hann grains taken at analysis marks
//! (spaced one input period apart, snapped to waveform peaks) and
//! overlap-added at the output period. Formants stay put; `formant` resamples
//! each grain to move them on purpose.
//!
//! A two-period grain cannot be heard before its right half exists, so the
//! delay is about two periods of the sung note. The output clock follows a
//! peak-hold of the period: it slows down (at most 8 %) when a lower note
//! needs more delay and catches up after high notes. Grain spacing is scaled
//! by the same rate, so the drift changes timing only, never pitch.

const SIZE: usize = 65_536;
const MASK: usize = SIZE - 1;
const MARKS: usize = 64;
/// Delay in periods of the held (lowest recent) note: one period for the
/// grain's right half, one for its centre, a quarter for mark lag.
const LAT_PERIODS: f32 = 1.25;
/// Largest output-clock deviation from real time.
const MAX_SLEW: f64 = 0.08;

pub struct Psola {
    sr: f32,
    input: Box<[f32]>,
    ola: Box<[f32]>,
    /// Samples written so far (absolute input time).
    n: u64,
    /// Output read time in input-time coordinates (fractional).
    out_t: f64,
    /// Every OLA slot before this one has been cleared.
    cleared: i64,
    /// Peak-hold of the voiced period (samples), decays over ~300 ms.
    period_hold: f32,
    hold_decay: f32,
    marks: [u64; MARKS],
    mark_head: usize,
    mark_count: usize,
    next_mark_search: u64,
    next_synth: f64,
}

impl Psola {
    pub fn new(sample_rate: f32) -> Self {
        let period_hold = sample_rate / 150.0;
        Self {
            sr: sample_rate,
            input: vec![0.0; SIZE].into_boxed_slice(),
            ola: vec![0.0; SIZE].into_boxed_slice(),
            n: 0,
            out_t: -f64::from(LAT_PERIODS * period_hold),
            cleared: 0,
            period_hold,
            hold_decay: 1.0 / (0.3 * sample_rate),
            marks: [0; MARKS],
            mark_head: 0,
            mark_count: 0,
            next_mark_search: 0,
            next_synth: 0.0,
        }
    }

    /// Current delay in samples.
    pub fn latency(&self) -> f32 {
        (self.n as f64 - self.out_t) as f32
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
            period.clamp(24.0, (SIZE / 8) as f32)
        } else {
            self.sr * 0.006
        };
        self.input[(self.n as usize) & MASK] = x;
        self.n += 1;

        // Output clock: chase `n - target` without ever moving faster than MAX_SLEW.
        if voiced {
            if period > self.period_hold {
                self.period_hold = period;
            } else {
                self.period_hold += (period - self.period_hold) * self.hold_decay;
            }
        }
        let target = f64::from((LAT_PERIODS - 1.0 + formant.max(1.0)) * self.period_hold)
            .max(f64::from(self.sr) * 0.003);
        let err = (self.n as f64 - target) - self.out_t;
        let rate = (1.0 + err / (0.05 * f64::from(self.sr))).clamp(1.0 - MAX_SLEW, 1.0 + MAX_SLEW);
        self.out_t += rate;

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

        // Synthesis in output-clock units: one real sample = `rate` units.
        let tau = self.out_t;
        let half = f64::from(period) * rate;
        if self.next_synth < tau {
            self.next_synth = tau + half;
        }
        let out_period = (f64::from(period) / ratio).max(16.0) * rate;
        let first = tau.floor() as i64 + 1;
        while self.next_synth - half <= tau {
            let s = self.next_synth;
            let src_half = f64::from(period) * f64::from(formant);
            let newest = self.n.saturating_sub(src_half as u64 + 2);
            let a = self
                .mark_before((s.max(0.0) as u64).min(newest))
                .unwrap_or(newest) as f64;
            let gain = (out_period / half).min(1.0) as f32;
            let len = (2.0 * half) as i64;
            let src_step = f64::from(formant) / rate;
            for k in 0..len {
                let off = k as f64 - half;
                let w = 0.5 - 0.5 * (std::f64::consts::TAU * k as f64 / len as f64).cos();
                let dst = (s + off).round() as i64;
                if dst >= first {
                    let v = self.at(a + off * src_step);
                    self.ola[(dst as usize) & MASK] += v * w as f32 * gain;
                }
            }
            self.next_synth += out_period;
        }

        // Read (linear between slots), clearing every slot the clock has passed.
        let i = tau.floor() as i64;
        while self.cleared < i {
            self.ola[(self.cleared as usize) & MASK] = 0.0;
            self.cleared += 1;
        }
        if i < 0 {
            return 0.0;
        }
        let f = (tau - i as f64) as f32;
        let a = self.ola[(i as usize) & MASK];
        let b = self.ola[((i + 1) as usize) & MASK];
        a + (b - a) * f
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
