//! TikSee vocal engine.
//!
//! Real-time pitch correction ("autotune") and a vocal chain, built to run
//! inside Voicemeeter's audio callback: nothing in [`Engine::process`]
//! allocates, locks or blocks.
//!
//! * Detection: McLeod Pitch Method on a sliding past window ([`pitch`]); it
//!   adds no audio latency, the estimate is a few ms old.
//! * Correction: scale snapping, retune speed, humanize, flex and vibrato
//!   handling ([`corrector`]).
//! * Shifting: a period-synchronous splice shifter (~1–4 ms, "Live") or
//!   TD-PSOLA with natural formants ("Natural", about two periods).
//! * Chain: gate, high-pass, parametric EQ, de-esser, compressor, harmonies
//!   and doubler, reverb and delay sends, limiter ([`fx`]).
//! * Music bus: key detection and ducking ([`key`]).

pub mod analysis;
pub mod corrector;
pub mod engine;
pub mod fx;
pub mod key;
pub mod params;
pub mod pitch;
pub mod psola;
pub mod scale;
pub mod shifter;

pub use engine::{Engine, Meter};
pub use params::VocalParams;
