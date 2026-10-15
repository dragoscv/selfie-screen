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
    harmony_shifters: [Splice; 3],
    double: Splice,
    gate: Gate,
    hpf: Biquad,
    eq: [Biquad; 5],
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
            harmony_shifters: [
                Splice::new(sample_rate),
                Splice::new(sample_rate),
                Splice::new(sample_rate),
            ],
            double: Splice::new(sample_rate),
            gate: Gate::default(),
            hpf: Biquad::default(),
            eq: [Biquad::default(); 5],
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
            ShiftMode::Natural => self.psola.latency(),
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
                ShiftMode::Natural => self.psola.process(
                    v,
                    ratio,
                    self.period,
                    self.correction.voiced,
                    semis(p.tune.formant),
                ),
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
        let sr = 48_000.0;
        for mode in [ShiftMode::Live, ShiftMode::Natural] {
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
            let input = tone(452.0, sr, 48_000);
            let mut l = vec![0.0; input.len()];
            let mut r = vec![0.0; input.len()];
            e.process(&input, &mut l, &mut r);
            let got = measure(&l[24_000..], sr);
            let cents = 1200.0 * (got / 440.0).log2();
            assert!(cents.abs() < 10.0, "{mode:?}: {got} Hz ({cents} c)");
            let m = e.meter();
            assert_eq!(m.target_midi, 69.0);
            assert!(m.latency_ms < 15.0, "{mode:?} latency {}", m.latency_ms);
        }
    }

    #[test]
    fn live_mode_latency_is_a_few_ms() {
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

    #[test]
    fn bypass_is_transparent() {
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
