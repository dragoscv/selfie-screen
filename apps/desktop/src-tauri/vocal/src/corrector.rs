//! Turns a detected pitch into a pitch ratio: target note, retune glide,
//! humanize on held notes, flex zone, vibrato handling, transpose.

use crate::params::Tune;
use crate::scale::{allowed, hz_to_midi, nearest};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Correction {
    /// Output/input frequency ratio to apply now.
    pub ratio: f32,
    pub detected_midi: f32,
    pub target_midi: f32,
    pub corrected_midi: f32,
    pub voiced: bool,
}

pub struct Corrector {
    /// Smoothed correction in semitones (the glide state).
    shift: f32,
    note: Option<i32>,
    held_s: f32,
    /// Slow average of the detected pitch: the note centre without vibrato.
    centre: f32,
    vib_phase: f32,
    unvoiced_s: f32,
}

impl Default for Corrector {
    fn default() -> Self {
        Self {
            shift: 0.0,
            note: None,
            held_s: 0.0,
            centre: 0.0,
            vib_phase: 0.0,
            unvoiced_s: 1.0,
        }
    }
}

impl Corrector {
    /// Called once per detector hop (`dt` seconds) with the latest estimate.
    pub fn update(&mut self, tune: &Tune, hz: Option<(f32, f32)>, dt: f32) -> Correction {
        let transpose = tune.transpose;
        let Some((hz, _)) = hz.filter(|(_, c)| *c >= 0.5 + 0.45 * (1.0 - tune.sensitivity)) else {
            // Unvoiced: hold the last correction briefly, then relax to transpose only.
            self.unvoiced_s += dt;
            if self.unvoiced_s > 0.08 {
                self.note = None;
                self.held_s = 0.0;
                self.shift += (0.0 - self.shift) * (dt / 0.05).min(1.0);
            }
            return Correction {
                ratio: semis(self.shift + transpose),
                ..Correction::default()
            };
        };
        let midi = hz_to_midi(hz);
        if self.unvoiced_s > 0.08 {
            self.centre = midi;
        }
        self.unvoiced_s = 0.0;
        // Centre follows slowly (vibrato is 4-7 Hz, so a ~0.15 s time constant averages it out).
        self.centre += (midi - self.centre) * (dt / 0.15).min(1.0);

        if !tune.enabled {
            self.shift = 0.0;
            return Correction {
                ratio: semis(transpose),
                detected_midi: midi,
                target_midi: midi,
                corrected_midi: midi + transpose,
                voiced: true,
            };
        }

        let mask = allowed(tune.key, tune.scale, tune.bypass);
        let target = nearest(self.centre, mask, self.note, 0.15);
        if Some(target) == self.note {
            self.held_s += dt;
        } else {
            self.note = Some(target);
            self.held_s = 0.0;
        }
        let deviation = midi - self.centre; // vibrato and fast wiggle
        let mut wanted = target as f32 - self.centre;
        if wanted.abs() * 100.0 < tune.flex_cents {
            wanted = 0.0;
        }
        // Vibrato: 0 removes it (cancel the wiggle), 1 keeps it, 2 doubles it.
        wanted += deviation * (tune.vibrato.clamp(0.0, 2.0) - 1.0);
        // Synthetic vibrato fades in on notes held longer than 0.25 s.
        if tune.vibrato_add_cents > 0.0 {
            self.vib_phase = (self.vib_phase + dt * tune.vibrato_rate_hz).fract();
            let fade = ((self.held_s - 0.25) / 0.3).clamp(0.0, 1.0);
            wanted += fade * tune.vibrato_add_cents / 100.0
                * (self.vib_phase * std::f32::consts::TAU).sin();
        }

        let retune_s =
            (tune.retune_ms + tune.humanize * 250.0 * (self.held_s / 0.6).min(1.0)) / 1000.0;
        let alpha = if retune_s <= 0.0005 {
            1.0
        } else {
            1.0 - (-dt / retune_s).exp()
        };
        // Track the vibrato part instantly (it is already in `deviation`), glide only the note part.
        self.shift += (wanted - self.shift) * alpha;
        let total = self.shift + transpose;
        Correction {
            ratio: semis(total),
            detected_midi: midi,
            target_midi: target as f32 + transpose,
            corrected_midi: midi + total,
            voiced: true,
        }
    }
}

#[inline]
pub fn semis(s: f32) -> f32 {
    (s / 12.0).exp2()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scale::Scale;

    fn run(tune: &Tune, hz: f32, steps: usize) -> Correction {
        let mut c = Corrector::default();
        let mut out = Correction::default();
        for _ in 0..steps {
            out = c.update(tune, Some((hz, 0.98)), 0.00267);
        }
        out
    }

    #[test]
    fn hard_tune_lands_on_the_note() {
        let tune = Tune {
            retune_ms: 0.0,
            humanize: 0.0,
            scale: Scale::Major,
            ..Tune::default()
        };
        // 450 Hz is A4 + 39 cents; target A4 (440).
        let c = run(&tune, 450.0, 200);
        assert_eq!(c.target_midi, 69.0);
        assert!((c.corrected_midi - 69.0).abs() < 0.01, "{c:?}");
    }

    #[test]
    fn flex_leaves_close_notes_alone() {
        let tune = Tune {
            retune_ms: 0.0,
            flex_cents: 50.0,
            ..Tune::default()
        };
        let c = run(&tune, 450.0, 200);
        assert!((c.corrected_midi - c.detected_midi).abs() < 0.01);
    }

    #[test]
    fn retune_speed_glides() {
        let tune = Tune {
            retune_ms: 100.0,
            humanize: 0.0,
            ..Tune::default()
        };
        let fast = run(&tune, 450.0, 8); // ~21 ms
        assert!(
            fast.corrected_midi > 69.05,
            "should not have arrived yet: {fast:?}"
        );
        let slow = run(&tune, 450.0, 400);
        assert!((slow.corrected_midi - 69.0).abs() < 0.02);
    }

    #[test]
    fn disabled_only_transposes() {
        let tune = Tune {
            enabled: false,
            transpose: 12.0,
            ..Tune::default()
        };
        let c = run(&tune, 220.0, 10);
        assert!((c.ratio - 2.0).abs() < 1e-4);
    }
}
