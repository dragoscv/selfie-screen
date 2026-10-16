//! The vocal engine: mono voice in → stereo voice out, plus an optional
//! music signal for key detection and ducking.
//!
//! Signal order: input gain → gate → HPF → EQ → de-esser → pitch correction
//! (+ harmonies/doubler) → compressor → reverb/delay sends → limiter.
//! Correction sits after the cleanup so the detector sees a clean voice, and
//! before the compressor so harmonies are levelled together.

use crate::corrector::{Correction, Corrector, semis};
use crate::fx::{Biquad, Compressor, DeEsser, Delay, Env, Gate, Limiter, Reverb, db, to_db};
use crate::key::{Ducker, KeyDetector, KeyGuess};
use crate::params::{ShiftMode, VocalParams};
use crate::pitch::Detector;
use crate::psola::Psola;
use crate::scale::{allowed, degree_offset};
use crate::shifter::Splice;

/// Natural mode hands over to PSOLA above this pitch (its delay is < 8 ms there)…
const NATURAL_ON_HZ: f32 = 170.0;
/// …and back to the splice shifter below this one.
const NATURAL_OFF_HZ: f32 = 155.0;

/// What the UI draws (copied out of the audio thread at ~60 Hz).
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub input_db: f32,
    pub output_db: f32,
    pub detected_midi: f32,
    pub target_midi: f32,
    pub corrected_midi: f32,
    pub voiced: bool,
    pub clarity: f32,
    pub comp_reduction_db: f32,
    pub deess_reduction_db: f32,
    pub duck_gain_db: f32,
    pub latency_ms: f32,
    pub key: Option<(u8, bool, f32)>,
    /// Key, scale and mode the audio thread is using right now (proves params arrived).
    pub active_key: u8,
    pub active_scale: crate::scale::Scale,
    pub active_mode: ShiftMode,
    pub tune_on: bool,
}

pub struct Engine {
    sr: f32,
    params: VocalParams,
    detector: Detector,
    corrector: Corrector,
    correction: Correction,
    clarity: f32,
    period: f32,
    splice: Splice,
    psola: Psola,
    /// Natural mode: 0 = splice, 1 = PSOLA (crossfaded, see `NATURAL_ON_HZ`).
    natural_mix: f32,
    natural_on: bool,
    harmony_shifters: [Splice; 3],
    double: Splice,
    gate: Gate,
    hpf: Biquad,
    eq: [Biquad; 5],
    notches: [Biquad; 4],
    deess: DeEsser,
    comp: Compressor,
    reverb: Box<Reverb>,
    delay: Delay,
    limiter: Limiter,
    in_env: Env,
    out_env: Env,
    key: KeyDetector,
    ducker: Ducker,
    duck_gain: f32,
    double_lfo: f32,
}

impl Engine {
    /// EQ + HPF response (dB) of `chain` at `freqs`, without an engine (for the UI).
    pub fn chain_curve(chain: &crate::params::Chain, sample_rate: f32, freqs: &[f32]) -> Vec<f32> {
        let mut hpf = Biquad::default();
        hpf.highpass(chain.hpf_hz, 0.707, sample_rate);
        let mut bands = [Biquad::default(); 5];
        for (bq, band) in bands.iter_mut().zip(chain.eq.iter()) {
            bq.band(band, sample_rate);
        }
        freqs
            .iter()
            .map(|&f| {
                let mut mag = if chain.hpf_on {
                    hpf.magnitude(f, sample_rate)
                } else {
                    1.0
                };
                if chain.eq_on {
                    for (bq, band) in bands.iter().zip(chain.eq.iter()) {
                        if band.on {
                            mag *= bq.magnitude(f, sample_rate);
                        }
                    }
                }
                to_db(mag)
            })
            .collect()
    }

    pub fn new(sample_rate: f32, params: VocalParams) -> Self {
        let mut e = Self {
            sr: sample_rate,
            params,
            detector: Detector::new(sample_rate),
            corrector: Corrector::default(),
            correction: Correction {
                ratio: 1.0,
                ..Correction::default()
            },
            clarity: 0.0,
            period: sample_rate / 200.0,
            splice: Splice::new(sample_rate),
            psola: Psola::new(sample_rate),
            natural_mix: 0.0,
            natural_on: false,
            harmony_shifters: [
                Splice::new(sample_rate),
                Splice::new(sample_rate),
                Splice::new(sample_rate),
            ],
            double: Splice::new(sample_rate),
            gate: Gate::default(),
            hpf: Biquad::default(),
            eq: [Biquad::default(); 5],
            notches: [Biquad::default(); 4],
            deess: DeEsser::default(),
            comp: Compressor::default(),
            reverb: Reverb::new(sample_rate),
            delay: Delay::new(),
            limiter: Limiter::default(),
            in_env: Env::default(),
            out_env: Env::default(),
            key: KeyDetector::new(sample_rate),
            ducker: Ducker::default(),
            duck_gain: 1.0,
            double_lfo: 0.0,
        };
        e.in_env.set(0.0, 300.0, sample_rate);
        e.out_env.set(0.0, 300.0, sample_rate);
        e.apply();
        e
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn params(&self) -> &VocalParams {
        &self.params
    }

    /// Recompute coefficients. Call from the audio thread when a new
    /// parameter set arrives (no allocation).
    pub fn set_params(&mut self, params: VocalParams) {
        if params == self.params {
            return;
        }
        self.params = params;
        self.apply();
    }

    fn apply(&mut self) {
        let sr = self.sr;
        let c = &self.params.chain;
        self.gate.set(c.gate_threshold_db, sr);
        self.hpf.highpass(c.hpf_hz, 0.707, sr);
        for (bq, &hz) in self.notches.iter_mut().zip(c.notch_hz.iter()) {
            if hz > 20.0 {
                bq.notch(hz, 30.0, sr);
            }
        }
        for (bq, band) in self.eq.iter_mut().zip(c.eq.iter()) {
            bq.band(band, sr);
        }
        self.deess.set(c.deess_hz, c.deess_threshold_db, sr);
        self.comp.set(
            c.comp_threshold_db,
            c.comp_ratio,
            c.comp_attack_ms,
            c.comp_release_ms,
            c.comp_makeup_db,
            sr,
        );
        self.reverb.set(c.reverb_size, c.reverb_damp);
        self.delay.set(c.delay_ms, c.delay_feedback, sr);
        self.limiter.set(c.limiter_ceiling_db, sr);
        self.ducker.set(self.params.duck.release_ms, sr);
        self.detector
            .set_range(self.params.tune.min_hz, self.params.tune.max_hz);
    }

    /// EQ curve (dB) at the given frequencies, for the UI.
    pub fn eq_curve(&self, freqs: &[f32], out: &mut [f32]) {
        let c = &self.params.chain;
        for (o, &f) in out.iter_mut().zip(freqs) {
            let mut mag = 1.0;
            if c.hpf_on {
                mag *= self.hpf.magnitude(f, self.sr);
            }
            if c.eq_on {
                for (bq, band) in self.eq.iter().zip(c.eq.iter()) {
                    if band.on {
                        mag *= bq.magnitude(f, self.sr);
                    }
                }
            }
            *o = to_db(mag);
        }
    }

    pub fn latency_samples(&self) -> f32 {
        if !self.params.tune.enabled && self.params.tune.transpose == 0.0 {
            return self.splice.latency();
        }
        match self.params.tune.mode {
            ShiftMode::Live => self.splice.latency(),
            ShiftMode::Natural if self.natural_mix >= 0.5 => self.psola.latency(),
            ShiftMode::Natural => self.splice.latency(),
        }
    }

    pub fn key_guess(&self) -> Option<KeyGuess> {
        self.key.guess()
    }

    pub fn meter(&self) -> Meter {
        Meter {
            input_db: to_db(self.in_env.value()),
            output_db: to_db(self.out_env.value()),
            detected_midi: self.correction.detected_midi,
            target_midi: self.correction.target_midi,
            corrected_midi: self.correction.corrected_midi,
            voiced: self.correction.voiced,
            clarity: self.clarity,
            comp_reduction_db: self.comp.reduction_db,
            deess_reduction_db: self.deess.reduction_db(),
            duck_gain_db: to_db(self.duck_gain),
            latency_ms: self.latency_samples() / self.sr * 1000.0,
            key: self
                .key
                .guess()
                .map(|g| (g.key, g.scale == crate::scale::Scale::Minor, g.confidence)),
            active_key: self.params.tune.key,
            active_scale: self.params.tune.scale,
            active_mode: self.params.tune.mode,
            tune_on: self.params.tune.enabled && !self.params.bypass,
        }
    }

    /// Feeds music (mono) for key detection; returns the duck gain to apply to it.
    #[inline]
    pub fn music_sample(&mut self, x: f32) -> f32 {
        self.key.push(x);
        if !self.params.duck.on {
            self.duck_gain = 1.0;
            return 1.0;
        }
        let singing = self.correction.voiced && self.in_env.value() > db(-45.0);
        self.duck_gain = self.ducker.run(singing, db(self.params.duck.depth_db));
        self.duck_gain
    }

    /// Processes a block of mono voice into stereo `left`/`right`.
    /// `input` may alias `left`.
    pub fn process(&mut self, input: &[f32], left: &mut [f32], right: &mut [f32]) {
        let n = input.len().min(left.len()).min(right.len());
        for i in 0..n {
            let (l, r) = self.sample(input[i]);
            left[i] = l;
            right[i] = r;
        }
    }

    /// In-place mono → stereo for Voicemeeter strips (`l` holds the input).
    pub fn process_inplace(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        for i in 0..n {
            let (a, b) = self.sample(l[i]);
            l[i] = a;
            r[i] = b;
        }
    }

    /// Natural mode: PSOLA needs ~1.25 periods of delay, so below ~160 Hz
    /// (8 ms) the splice shifter takes over. Both run warm and crossfade in
    /// 30 ms with hysteresis, so a phrase never clicks at the hand-over.
    #[inline]
    fn natural(&mut self, v: f32, ratio: f32, formant: f32) -> f32 {
        if self.correction.voiced {
            let hz = self.sr / self.period;
            if hz > NATURAL_ON_HZ {
                self.natural_on = true;
            } else if hz < NATURAL_OFF_HZ {
                self.natural_on = false;
            }
        }
        let step = 1.0 / (0.03 * self.sr);
        let goal = if self.natural_on { 1.0 } else { 0.0 };
        self.natural_mix += (goal - self.natural_mix).clamp(-step, step);
        let a = self.splice.process(v, ratio, self.period);
        let b = self
            .psola
            .process(v, ratio, self.period, self.correction.voiced, formant);
        a + (b - a) * self.natural_mix
    }

    #[inline]
    pub fn sample(&mut self, x: f32) -> (f32, f32) {
        let p = self.params;
        if p.bypass {
            self.in_env.run(x);
            self.out_env.run(x);
            return (x, x);
        }
        let c = p.chain;
        let mut v = x * db(c.input_gain_db);
        if c.notch_on {
            for (bq, &hz) in self.notches.iter_mut().zip(c.notch_hz.iter()) {
                if hz > 20.0 {
                    v = bq.run(v);
                }
            }
        }
        self.in_env.run(v);
        if c.gate_on {
            v = self.gate.run(v);
        }
        if c.hpf_on {
            v = self.hpf.run(v);
        }
        if c.eq_on {
            for (bq, band) in self.eq.iter_mut().zip(c.eq.iter()) {
                if band.on {
                    v = bq.run(v);
                }
            }
        }
        if c.deess_on {
            v = self.deess.run(v);
        }

        // Pitch.
        if let Some(est) = self.detector.push(v) {
            let dt = self.detector.hop() as f32 / self.sr;
            self.clarity = est.map_or(0.0, |e| e.clarity);
            if let Some(e) = est {
                self.period = self.sr / e.hz;
            }
            self.correction = self
                .corrector
                .update(&p.tune, est.map(|e| (e.hz, e.clarity)), dt);
        }
        let ratio = self.correction.ratio;
        let shifting = p.tune.enabled || p.tune.transpose != 0.0;
        let lead = if !shifting {
            v
        } else {
            match p.tune.mode {
                ShiftMode::Live => self.splice.process(v, ratio, self.period),
                ShiftMode::Natural => self.natural(v, ratio, semis(p.tune.formant)),
            }
        };
        let lead = lead * p.tune.mix + v * (1.0 - p.tune.mix);

        // Harmonies follow the corrected note, in key.
        let mut hl = 0.0;
        let mut hr = 0.0;
        let mask = allowed(p.tune.key, p.tune.scale, 0);
        let note = self.correction.target_midi.round() as i32;
        for (shifter, voice) in self
            .harmony_shifters
            .iter_mut()
            .zip(p.harmony.voices.iter())
        {
            if !voice.on {
                continue;
            }
            let off = degree_offset(note, mask, i32::from(voice.degrees));
            let y =
                shifter.process(lead, semis(off as f32), self.period / ratio) * db(voice.gain_db);
            let pan = (voice.pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
            hl += y * pan.cos();
            hr += y * pan.sin();
        }
        if p.harmony.double > 0.0 {
            self.double_lfo = (self.double_lfo + 0.37 / self.sr).fract();
            let detune = 0.08 * (self.double_lfo * std::f32::consts::TAU).sin();
            let y = self
                .double
                .process(lead, semis(detune + 0.06), self.period / ratio)
                * p.harmony.double
                * 0.7;
            hl += y * 0.9;
            hr += y * 0.5;
        }

        // Compressor keyed on the lead, applied to everything.
        let g = if c.comp_on {
            self.comp.gain_for(lead)
        } else {
            1.0
        };
        let mut l = (lead + hl) * g;
        let mut r = (lead + hr) * g;
        let mono = (l + r) * 0.5;
        if c.reverb_on && c.reverb_mix > 0.0 {
            let (a, b) = self.reverb.run(mono);
            l += a * c.reverb_mix * 3.0;
            r += b * c.reverb_mix * 3.0;
        }
        if c.delay_on && c.delay_mix > 0.0 {
            let d = self.delay.run(mono) * c.delay_mix;
            l += d;
            r += d;
        }
        let out_gain = db(c.output_gain_db);
        l *= out_gain;
        r *= out_gain;
        if c.limiter_on {
            (l, r) = self.limiter.run_stereo(l, r);
        }
        self.out_env.run(l.abs().max(r.abs()));
        (l, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{Chain, Tune};
    use crate::scale::Scale;
    use crate::shifter::tests::{measure, tone};

    fn quiet_chain() -> Chain {
        Chain {
            gate_on: false,
            eq_on: false,
            deess_on: false,
            comp_on: false,
            reverb_on: false,
            delay_on: false,
            limiter_on: false,
            hpf_on: false,
            ..Chain::default()
        }
    }

    #[test]
    fn corrects_an_out_of_tune_note_to_the_scale() {
        for (sr, mode) in [
            (48_000.0, ShiftMode::Live),
            (48_000.0, ShiftMode::Natural),
            (176_400.0, ShiftMode::Live),
            (176_400.0, ShiftMode::Natural),
        ] {
            let params = VocalParams {
                tune: Tune {
                    scale: Scale::Major,
                    key: 9,
                    retune_ms: 0.0,
                    humanize: 0.0,
                    vibrato: 0.0,
                    mode,
                    ..Tune::default()
                },
                chain: quiet_chain(),
                ..VocalParams::default()
            };
            let mut e = Engine::new(sr, params);
            // 452 Hz = A4 + 47 cents -> must land on A4 (A major contains A).
            let n = sr as usize;
            let input = tone(452.0, sr, n);
            let mut l = vec![0.0; input.len()];
            let mut r = vec![0.0; input.len()];
            e.process(&input, &mut l, &mut r);
            let got = measure(&l[n / 2..], sr);
            let cents = 1200.0 * (got / 440.0).log2();
            assert!(cents.abs() < 10.0, "{sr} {mode:?}: {got} Hz ({cents} c)");
            let m = e.meter();
            assert_eq!(m.target_midi, 69.0);
            assert!(
                m.latency_ms < 15.0,
                "{sr} {mode:?} latency {}",
                m.latency_ms
            );
        }
    }

    #[test]
    fn live_mode_latency_is_a_few_ms() {
        key_change_body();
        live_latency_body();
    }

    /// Owner report 2026-10-16: "when I change the key nothing happens".
    /// Real settings (Natural, retune 80 ms, humanize 0.6, flex 15 c); a held
    /// 466 Hz note (A#4). In C major the nearest note is B (or A); after
    /// switching to A# major, A#4 itself is in key and must pass through.
    fn key_change_body() {
        let sr = 48_000.0;
        let mut tune = Tune {
            key: 0,
            scale: Scale::Major,
            retune_ms: 80.0,
            humanize: 0.6,
            flex_cents: 15.0,
            mode: ShiftMode::Natural,
            ..Tune::default()
        };
        let mut e = Engine::new(
            sr,
            VocalParams {
                tune,
                chain: quiet_chain(),
                ..VocalParams::default()
            },
        );
        let input = tone(466.16, sr, sr as usize);
        let mut l = vec![0.0; input.len()];
        let mut r = vec![0.0; input.len()];
        e.process(&input, &mut l, &mut r);
        let in_c = e.meter();
        assert!(
            in_c.target_midi == 69.0 || in_c.target_midi == 71.0,
            "C major target {in_c:?}"
        );
        let c_out = measure(&l[24_000..], sr);
        tune.key = 10; // A#
        e.set_params(VocalParams {
            tune,
            chain: quiet_chain(),
            ..VocalParams::default()
        });
        e.process(&input, &mut l, &mut r);
        let in_as = e.meter();
        assert_eq!(in_as.target_midi, 70.0, "A# major target {in_as:?}");
        let as_out = measure(&l[24_000..], sr);
        let cents = 1200.0 * (as_out / 466.16).log2();
        assert!(
            cents.abs() < 10.0,
            "after key change output {as_out} Hz ({cents} c), before {c_out} Hz"
        );
        assert!(
            (1200.0 * (c_out / 466.16).log2()).abs() > 60.0,
            "in C major the note must move: {c_out} Hz"
        );
    }

    fn live_latency_body() {
        let sr = 48_000.0;
        let mut e = Engine::new(
            sr,
            VocalParams {
                chain: quiet_chain(),
                ..VocalParams::default()
            },
        );
        let input = tone(220.0, sr, 9_600);
        let mut l = vec![0.0; input.len()];
        let mut r = vec![0.0; input.len()];
        e.process(&input, &mut l, &mut r);
        assert!(
            e.meter().latency_ms < 1.5 + 1000.0 / 220.0 + 3.0,
            "{}",
            e.meter().latency_ms
        );
    }

    #[test]
    fn full_chain_stays_finite_and_under_ceiling() {
        let sr = 48_000.0;
        let mut params = VocalParams::default();
        params.harmony.voices[0].on = true;
        params.harmony.voices[1].on = true;
        params.harmony.double = 0.5;
        params.chain.delay_on = true;
        let mut e = Engine::new(sr, params);
        let input: Vec<f32> = tone(196.0, sr, 48_000).iter().map(|x| x * 1.8).collect();
        let mut l = vec![0.0; input.len()];
        let mut r = vec![0.0; input.len()];
        e.process(&input, &mut l, &mut r);
        let ceiling = db(params.chain.limiter_ceiling_db) + 1e-5;
        assert!(
            l.iter()
                .chain(r.iter())
                .all(|v| v.is_finite() && v.abs() <= ceiling)
        );
        let m = e.meter();
        assert!(m.comp_reduction_db > 0.0);
    }

    /// Measured shifter latency (mean / max while singing) per mode, note and rate.
    /// `cargo test --release latency_report -- --nocapture`
    #[test]
    fn latency_report() {
        for sr in [48_000.0f32, 176_400.0] {
            for mode in [ShiftMode::Live, ShiftMode::Natural] {
                for hz in [110.0f32, 165.0, 220.0, 330.0, 440.0] {
                    let params = VocalParams {
                        tune: Tune {
                            transpose: 1.0,
                            retune_ms: 0.0,
                            mode,
                            ..Tune::default()
                        },
                        chain: quiet_chain(),
                        ..VocalParams::default()
                    };
                    let mut e = Engine::new(sr, params);
                    let input = tone(hz, sr, sr as usize);
                    let (mut sum, mut max, mut k) = (0.0f32, 0.0f32, 0usize);
                    let mut l = vec![0.0; 256];
                    let mut r = vec![0.0; 256];
                    let mut q = Detector::new(sr);
                    let (mut csum, mut cn) = (0.0f32, 0usize);
                    for (i, block) in input.chunks(256).enumerate() {
                        e.process(block, &mut l, &mut r);
                        for &y in &l {
                            if let Some(Some(est)) = q.push(y)
                                && i * 256 > input.len() / 4
                            {
                                csum += est.clarity;
                                cn += 1;
                            }
                        }
                        if i * 256 > input.len() / 4 {
                            let ms = e.meter().latency_ms;
                            sum += ms;
                            max = max.max(ms);
                            k += 1;
                        }
                    }
                    let mean = sum / k as f32;
                    let clarity = csum / cn.max(1) as f32;
                    println!(
                        "LAT sr={sr} {mode:?} {hz} Hz mean={mean:.2} ms max={max:.2} ms clarity={clarity:.4}"
                    );
                    // Live: < 6 ms on average, the splice peak is base + one period.
                    // Natural: PSOLA (>= 170 Hz) never above 8 ms; below, Live's numbers.
                    assert!(mean < 6.0 || (mode == ShiftMode::Natural && hz >= 170.0 && max < 8.0));
                    assert!(max < 11.0, "{sr} {mode:?} {hz} Hz max {max}");
                    if mode == ShiftMode::Natural && hz >= NATURAL_ON_HZ {
                        assert!(max < 8.0, "{sr} PSOLA {hz} Hz max {max}");
                    }
                    assert!(clarity > 0.99, "{sr} {mode:?} {hz} Hz clarity {clarity}");
                }
            }
        }
    }

    #[test]
    fn bypass_is_transparent() {
        // (kept below)
        bypass_is_transparent_body();
    }

    #[test]
    fn notch_removes_the_whine_only() {
        let sr = 48_000.0;
        let mut chain = quiet_chain();
        chain.notch_hz = [493.9, 0.0, 0.0, 0.0];
        let params = VocalParams {
            tune: Tune {
                enabled: false,
                ..Tune::default()
            },
            chain,
            ..VocalParams::default()
        };
        let rms_out = |hz: f32| {
            let mut e = Engine::new(sr, params);
            let x: Vec<f32> = (0..24_000)
                .map(|i| 0.3 * (std::f32::consts::TAU * hz * i as f32 / sr).sin())
                .collect();
            let mut l = vec![0.0; x.len()];
            let mut r = vec![0.0; x.len()];
            e.process(&x, &mut l, &mut r);
            (l[12_000..].iter().map(|v| v * v).sum::<f32>() / 12_000.0).sqrt()
        };
        let whine = to_db(rms_out(493.9) / 0.212);
        let voice = to_db(rms_out(1000.0) / 0.212);
        assert!(whine < -25.0, "whine {whine} dB");
        assert!(voice.abs() < 0.5, "1 kHz {voice} dB");
    }

    fn bypass_is_transparent_body() {
        let mut e = Engine::new(
            48_000.0,
            VocalParams {
                bypass: true,
                ..VocalParams::default()
            },
        );
        let input = tone(300.0, 48_000.0, 512);
        let mut l = vec![0.0; 512];
        let mut r = vec![0.0; 512];
        e.process(&input, &mut l, &mut r);
        assert_eq!(l, input);
    }

    /// `cargo test --release -- --ignored cpu_cost --nocapture`
    #[test]
    #[ignore = "benchmark"]
    fn cpu_cost_of_full_chain() {
        let sr = 48_000.0;
        let mut params = VocalParams::default();
        params.tune.scale = Scale::Major;
        params.harmony.voices.iter_mut().for_each(|v| v.on = true);
        params.harmony.double = 0.5;
        params.chain.delay_on = true;
        for mode in [ShiftMode::Live, ShiftMode::Natural] {
            params.tune.mode = mode;
            let mut e = Engine::new(sr, params);
            let input = tone(220.0, sr, 48_000 * 10);
            let mut l = vec![0.0; 256];
            let mut r = vec![0.0; 256];
            let t = std::time::Instant::now();
            for block in input.chunks(256) {
                e.process(block, &mut l, &mut r);
                let _ = e.music_sample(block[0]);
            }
            let secs = t.elapsed().as_secs_f64();
            println!(
                "{mode:?}: 10 s of audio in {:.1} ms = {:.2} % of one core",
                secs * 1000.0,
                secs / 10.0 * 100.0
            );
        }
    }
}
