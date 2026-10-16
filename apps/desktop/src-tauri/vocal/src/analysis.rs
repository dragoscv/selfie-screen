//! Offline analysis of a captured mic recording (calibration and diagnostics):
//! noise floor, narrowband tones (whine / hum), level and sung range.
//! Runs on the control thread, never in the audio callback.

use realfft::RealFftPlanner;
use serde::Serialize;

use crate::pitch::Detector;
use crate::scale::hz_to_midi;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tone {
    pub hz: f32,
    /// Peak level, dBFS.
    pub db: f32,
    /// How far it stands above the local spectrum, dB.
    pub prominence_db: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseReport {
    /// RMS of the whole capture, dBFS.
    pub rms_db: f32,
    /// 10th percentile of 20 ms RMS frames (the real floor), dBFS.
    pub floor_db: f32,
    /// Peak sample, dBFS.
    pub peak_db: f32,
    /// Narrowband tones, loudest first (at most 6).
    pub tones: Vec<Tone>,
    /// Mains hum detected (50/60 Hz family).
    pub hum_hz: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceReport {
    pub rms_db: f32,
    pub peak_db: f32,
    /// Lowest / highest steadily sung MIDI notes (5th/95th percentile).
    pub low_midi: f32,
    pub high_midi: f32,
    /// Share of voiced analysis frames, 0..1.
    pub voiced: f32,
    /// Ratio of 5–10 kHz energy to 200 Hz–2 kHz, dB (sibilance).
    pub sibilance_db: f32,
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

/// Averaged magnitude spectrum (Hann, 50 % overlap) of `x`; returns (bin Hz, dB).
fn spectrum(x: &[f32], sr: f32, n: usize) -> (f32, Vec<f32>) {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut input = fft.make_input_vec();
    let mut out = fft.make_output_vec();
    let mut acc = vec![0.0f64; out.len()];
    let win: Vec<f32> = (0..n)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos())
        .collect();
    let mut frames = 0;
    let mut start = 0;
    while start + n <= x.len() {
        for i in 0..n {
            input[i] = x[start + i] * win[i];
        }
        if fft.process(&mut input, &mut out).is_ok() {
            for (a, c) in acc.iter_mut().zip(&out) {
                *a += f64::from(c.norm_sqr());
            }
            frames += 1;
        }
        start += n / 2;
    }
    let norm = (n as f64 / 4.0).powi(2) * f64::from(frames.max(1)); // Hann coherent gain 0.5
    let mags = acc
        .iter()
        .map(|a| 10.0 * (a / norm).max(1e-18).log10() as f32)
        .collect();
    (sr / n as f32, mags)
}

/// Finds narrowband tones: bins far above the median of their ±1/3-octave neighbourhood.
fn find_tones(bin_hz: f32, mags: &[f32]) -> Vec<Tone> {
    let mut tones: Vec<Tone> = Vec::new();
    let lo = (40.0 / bin_hz) as usize;
    let hi = ((18_000.0 / bin_hz) as usize).min(mags.len().saturating_sub(2));
    let mut scratch = Vec::new();
    for k in lo.max(2)..hi {
        let v = mags[k];
        if v < mags[k - 1] || v < mags[k + 1] {
            continue;
        }
        let f = k as f32 * bin_hz;
        let a = ((f / 1.26 / bin_hz) as usize).max(1);
        let b = ((f * 1.26 / bin_hz) as usize).min(mags.len() - 1);
        scratch.clear();
        scratch.extend(mags[a..=b].iter().copied());
        scratch.sort_by(f32::total_cmp);
        let median = scratch[scratch.len() / 2];
        let prom = v - median;
        if prom >= 15.0 && v > -100.0 {
            // Parabolic interpolation of the peak bin.
            let (y0, y1, y2) = (mags[k - 1], v, mags[k + 1]);
            let d = y0 - 2.0 * y1 + y2;
            let off = if d.abs() > 1e-6 {
                0.5 * (y0 - y2) / d
            } else {
                0.0
            };
            tones.push(Tone {
                hz: (k as f32 + off.clamp(-0.5, 0.5)) * bin_hz,
                db: v,
                prominence_db: prom,
            });
        }
    }
    tones.sort_by(|a, b| b.db.total_cmp(&a.db));
    // Keep distinct tones (merge within 2 bins).
    let mut out: Vec<Tone> = Vec::new();
    for t in tones {
        if out.iter().all(|o| (o.hz - t.hz).abs() > bin_hz * 2.5) {
            out.push(t);
        }
        if out.len() == 6 {
            break;
        }
    }
    out
}

/// Analyses a recording of the mic with nobody singing.
pub fn noise(x: &[f32], sr: f32) -> NoiseReport {
    let frame = ((sr * 0.02) as usize).max(64);
    let mut rms: Vec<f32> = x
        .chunks(frame)
        .filter(|c| c.len() == frame)
        .map(|c| (c.iter().map(|v| v * v).sum::<f32>() / frame as f32).sqrt())
        .collect();
    rms.sort_by(f32::total_cmp);
    let floor = rms.get(rms.len() / 10).copied().unwrap_or(0.0);
    let total = (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let n = if sr > 96_000.0 { 32_768 } else { 16_384 };
    let (bin, mags) = spectrum(x, sr, n.min(x.len().next_power_of_two() / 2).max(1024));
    let tones = find_tones(bin, &mags);
    let hum_hz = tones.iter().find_map(|t| {
        [50.0f32, 60.0].into_iter().find(|base| {
            let h = t.hz / base;
            (h - h.round()).abs() < 0.02 && h.round() >= 1.0 && h.round() <= 6.0
        })
    });
    NoiseReport {
        rms_db: db(total),
        floor_db: db(floor),
        peak_db: db(peak),
        tones,
        hum_hz,
    }
}

/// Analyses a recording of the singer (scale run, lowest to highest note).
pub fn voice(x: &[f32], sr: f32) -> VoiceReport {
    let mut det = Detector::new(sr);
    det.set_range(60.0, 1200.0);
    let mut notes = Vec::new();
    let mut frames = 0usize;
    for &v in x {
        if let Some(e) = det.push(v) {
            frames += 1;
            if let Some(e) = e.filter(|e| e.clarity > 0.85) {
                notes.push(hz_to_midi(e.hz));
            }
        }
    }
    notes.sort_by(f32::total_cmp);
    let pick = |q: f32| {
        notes
            .get(((notes.len() as f32 - 1.0) * q).round().max(0.0) as usize)
            .copied()
            .unwrap_or(0.0)
    };
    let total = (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let (bin, mags) = spectrum(x, sr, 4096.min(x.len().next_power_of_two() / 2).max(1024));
    let band = |a: f32, b: f32| {
        let (i, j) = ((a / bin) as usize, ((b / bin) as usize).min(mags.len() - 1));
        let e: f32 = mags[i..=j].iter().map(|d| 10f32.powf(d / 10.0)).sum();
        10.0 * (e / (j - i + 1) as f32).max(1e-18).log10()
    };
    VoiceReport {
        rms_db: db(total),
        peak_db: db(peak),
        low_midi: pick(0.05),
        high_midi: pick(0.95),
        voiced: notes.len() as f32 / frames.max(1) as f32,
        sibilance_db: band(5000.0, 10_000.0) - band(200.0, 2000.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise_with_whine(sr: f32, secs: f32) -> Vec<f32> {
        let mut seed = 7u32;
        (0..(sr * secs) as usize)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = ((seed >> 9) as f32 / 8_388_608.0 - 1.0) * 0.002;
                let t = i as f32 / sr;
                n + 0.003 * (std::f32::consts::TAU * 493.9 * t).sin()
                    + 0.001 * (std::f32::consts::TAU * 50.0 * t).sin()
            })
            .collect()
    }

    #[test]
    fn finds_the_whine_and_the_hum() {
        let r = noise(&noise_with_whine(48_000.0, 4.0), 48_000.0);
        let top = r.tones.first().expect("tone");
        assert!((top.hz - 493.9).abs() < 2.0, "{r:?}");
        assert!(r.tones.iter().any(|t| (t.hz - 50.0).abs() < 2.0), "{r:?}");
        assert_eq!(r.hum_hz, Some(50.0));
        assert!(r.floor_db < -45.0 && r.floor_db > -70.0, "{}", r.floor_db);
    }

    #[test]
    fn white_noise_has_no_tones() {
        let mut seed = 3u32;
        let x: Vec<f32> = (0..96_000)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 9) as f32 / 8_388_608.0 - 1.0) * 0.01
            })
            .collect();
        assert!(noise(&x, 48_000.0).tones.is_empty());
    }

    #[test]
    fn voice_range_of_a_scale_run() {
        let sr = 48_000.0;
        let mut x = Vec::new();
        for midi in [48, 50, 52, 53, 55, 57, 59, 60, 62, 64] {
            let hz = 440.0 * ((midi - 69) as f32 / 12.0).exp2();
            for i in 0..(sr as usize / 3) {
                let t = i as f32 / sr;
                x.push(
                    0.3 * (std::f32::consts::TAU * hz * t).sin()
                        + 0.15 * (std::f32::consts::TAU * 2.0 * hz * t).sin(),
                );
            }
        }
        let r = voice(&x, sr);
        assert!(
            (r.low_midi - 48.0).abs() < 1.0 && (r.high_midi - 64.0).abs() < 1.0,
            "{r:?}"
        );
        assert!(r.voiced > 0.8);
    }
}
