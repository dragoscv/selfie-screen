//! Every user-facing knob of the vocal engine (serialised camelCase, shared
//! with the renderer via `@tiksee/core` `vocalSchema`).

use serde::{Deserialize, Serialize};

use crate::scale::Scale;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ShiftMode {
    /// Period splice: lowest latency (~1–4 ms), formants move slightly.
    #[default]
    Live,
    /// TD-PSOLA: natural formants, about two periods of latency.
    Natural,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tune {
    pub enabled: bool,
    /// 0 = C … 11 = B.
    pub key: u8,
    pub scale: Scale,
    /// Notes switched off (bit per absolute pitch class, bit 0 = C).
    pub bypass: u16,
    /// Time to reach the target note, ms (0 = hard tune).
    pub retune_ms: f32,
    /// Extra retune time on held notes, 0..1 (keeps long notes natural).
    pub humanize: f32,
    /// Notes closer than this many cents to the target are left alone (Flex).
    pub flex_cents: f32,
    /// 0 = flatten vibrato, 1 = keep it, up to 2 = exaggerate.
    pub vibrato: f32,
    /// Synthetic vibrato depth (cents) and rate (Hz) added on held notes.
    pub vibrato_add_cents: f32,
    pub vibrato_rate_hz: f32,
    /// Global transpose, semitones.
    pub transpose: f32,
    /// Formant shift, semitones (Natural mode; Live keeps formants with the pitch).
    pub formant: f32,
    pub mode: ShiftMode,
    /// Detection range.
    pub min_hz: f32,
    pub max_hz: f32,
    /// 0..1: below this NSDF clarity the voice counts as unvoiced (no correction).
    pub sensitivity: f32,
    /// 0..1 dry/wet of the corrected voice.
    pub mix: f32,
}

impl Default for Tune {
    fn default() -> Self {
        Self {
            enabled: true,
            key: 0,
            scale: Scale::Chromatic,
            bypass: 0,
            retune_ms: 40.0,
            humanize: 0.3,
            flex_cents: 0.0,
            vibrato: 1.0,
            vibrato_add_cents: 0.0,
            vibrato_rate_hz: 5.5,
            transpose: 0.0,
            formant: 0.0,
            mode: ShiftMode::Live,
            min_hz: 75.0,
            max_hz: 1000.0,
            sensitivity: 0.6,
            mix: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BandKind {
    #[default]
    Peak,
    LowShelf,
    HighShelf,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Band {
    pub on: bool,
    pub kind: BandKind,
    pub hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

impl Default for Band {
    fn default() -> Self {
        Self {
            on: true,
            kind: BandKind::Peak,
            hz: 1000.0,
            gain_db: 0.0,
            q: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Chain {
    pub input_gain_db: f32,
    pub gate_on: bool,
    pub gate_threshold_db: f32,
    pub hpf_on: bool,
    pub hpf_hz: f32,
    pub eq_on: bool,
    pub eq: [Band; 5],
    pub deess_on: bool,
    pub deess_hz: f32,
    pub deess_threshold_db: f32,
    pub comp_on: bool,
    pub comp_threshold_db: f32,
    pub comp_ratio: f32,
    pub comp_attack_ms: f32,
    pub comp_release_ms: f32,
    pub comp_makeup_db: f32,
    pub reverb_on: bool,
    pub reverb_mix: f32,
    pub reverb_size: f32,
    pub reverb_damp: f32,
    pub delay_on: bool,
    pub delay_mix: f32,
    pub delay_ms: f32,
    pub delay_feedback: f32,
    pub limiter_on: bool,
    pub limiter_ceiling_db: f32,
    pub output_gain_db: f32,
}

impl Default for Chain {
    fn default() -> Self {
        Self {
            input_gain_db: 0.0,
            gate_on: true,
            gate_threshold_db: -50.0,
            hpf_on: true,
            hpf_hz: 90.0,
            eq_on: true,
            eq: [
                Band {
                    kind: BandKind::LowShelf,
                    hz: 120.0,
                    gain_db: 0.0,
                    q: 0.7,
                    on: true,
                },
                Band {
                    hz: 300.0,
                    gain_db: -2.0,
                    q: 1.0,
                    ..Band::default()
                },
                Band {
                    hz: 2500.0,
                    gain_db: 1.5,
                    q: 1.0,
                    ..Band::default()
                },
                Band {
                    hz: 5000.0,
                    gain_db: 0.0,
                    q: 1.2,
                    ..Band::default()
                },
                Band {
                    kind: BandKind::HighShelf,
                    hz: 10_000.0,
                    gain_db: 2.0,
                    q: 0.7,
                    on: true,
                },
            ],
            deess_on: true,
            deess_hz: 6500.0,
            deess_threshold_db: -28.0,
            comp_on: true,
            comp_threshold_db: -20.0,
            comp_ratio: 3.0,
            comp_attack_ms: 8.0,
            comp_release_ms: 120.0,
            comp_makeup_db: 4.0,
            reverb_on: true,
            reverb_mix: 0.15,
            reverb_size: 0.6,
            reverb_damp: 0.4,
            delay_on: false,
            delay_mix: 0.12,
            delay_ms: 320.0,
            delay_feedback: 0.3,
            limiter_on: true,
            limiter_ceiling_db: -1.0,
            output_gain_db: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Voice {
    pub on: bool,
    /// Scale degrees from the corrected note (+2 = third above); chromatic keys use semitones.
    pub degrees: i8,
    pub gain_db: f32,
    /// -1 left … 1 right.
    pub pan: f32,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            on: false,
            degrees: 2,
            gain_db: -6.0,
            pan: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Harmony {
    pub voices: [Voice; 3],
    /// Doubler: a slightly detuned, delayed copy (0 = off).
    pub double: f32,
}

impl Default for Harmony {
    fn default() -> Self {
        Self {
            voices: [
                Voice {
                    degrees: 2,
                    pan: -0.4,
                    ..Voice::default()
                },
                Voice {
                    degrees: 4,
                    pan: 0.4,
                    ..Voice::default()
                },
                Voice {
                    degrees: -3,
                    pan: 0.0,
                    ..Voice::default()
                },
            ],
            double: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Duck {
    pub on: bool,
    /// Music attenuation while singing, dB (negative).
    pub depth_db: f32,
    pub release_ms: f32,
}

impl Default for Duck {
    fn default() -> Self {
        Self {
            on: false,
            depth_db: -8.0,
            release_ms: 400.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocalParams {
    pub bypass: bool,
    pub tune: Tune,
    pub chain: Chain,
    pub harmony: Harmony,
    pub duck: Duck,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_fills_defaults() {
        let p: VocalParams = serde_json::from_str(r#"{"tune":{"key":9,"scale":"minor"}}"#).unwrap();
        assert_eq!(p.tune.key, 9);
        assert_eq!(p.tune.scale, Scale::Minor);
        assert!((p.tune.retune_ms - 40.0).abs() < f32::EPSILON);
        assert!(p.chain.comp_on);
    }
}
