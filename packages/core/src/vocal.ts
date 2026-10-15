import { z } from "zod";

/**
 * Vocal engine settings (WS-30). `params` mirrors the Rust `tiksee_vocal::VocalParams`
 * (serde camelCase, every field defaulted on both sides); the main window
 * pushes it to the shell, which runs the engine inside Voicemeeter's audio
 * callback — the vocal window is control and visuals only.
 */

export const VOCAL_SCALES = [
    "chromatic",
    "major",
    "minor",
    "harmonicMinor",
    "melodicMinor",
    "dorian",
    "phrygian",
    "lydian",
    "mixolydian",
    "locrian",
    "majorPentatonic",
    "minorPentatonic",
    "blues",
] as const;
export type VocalScale = (typeof VOCAL_SCALES)[number];

export const VOCAL_MODES = ["live", "natural"] as const;
export const EQ_BAND_KINDS = ["peak", "lowShelf", "highShelf"] as const;
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

const tuneSchema = z.object({
    enabled: z.boolean().default(true),
    key: z.number().int().min(0).max(11).default(0),
    scale: z.enum(VOCAL_SCALES).default("chromatic"),
    /** Notes switched off, bit per pitch class (bit 0 = C). */
    bypass: z.number().int().min(0).max(4095).default(0),
    retuneMs: z.number().min(0).max(400).default(40),
    humanize: z.number().min(0).max(1).default(0.3),
    flexCents: z.number().min(0).max(100).default(0),
    vibrato: z.number().min(0).max(2).default(1),
    vibratoAddCents: z.number().min(0).max(100).default(0),
    vibratoRateHz: z.number().min(2).max(9).default(5.5),
    transpose: z.number().min(-12).max(12).default(0),
    formant: z.number().min(-6).max(6).default(0),
    mode: z.enum(VOCAL_MODES).default("live"),
    minHz: z.number().min(50).max(400).default(75),
    maxHz: z.number().min(300).max(1500).default(1000),
    sensitivity: z.number().min(0).max(1).default(0.6),
    mix: z.number().min(0).max(1).default(1),
});

const bandSchema = z.object({
    on: z.boolean().default(true),
    kind: z.enum(EQ_BAND_KINDS).default("peak"),
    hz: z.number().min(20).max(20_000).default(1000),
    gainDb: z.number().min(-18).max(18).default(0),
    q: z.number().min(0.1).max(10).default(1),
});
export type EqBand = z.infer<typeof bandSchema>;

const DEFAULT_EQ: EqBand[] = [
    { on: true, kind: "lowShelf", hz: 120, gainDb: 0, q: 0.7 },
    { on: true, kind: "peak", hz: 300, gainDb: -2, q: 1 },
    { on: true, kind: "peak", hz: 2500, gainDb: 1.5, q: 1 },
    { on: true, kind: "peak", hz: 5000, gainDb: 0, q: 1.2 },
    { on: true, kind: "highShelf", hz: 10_000, gainDb: 2, q: 0.7 },
];

const chainSchema = z.object({
    inputGainDb: z.number().min(-24).max(24).default(0),
    gateOn: z.boolean().default(true),
    gateThresholdDb: z.number().min(-90).max(0).default(-50),
    hpfOn: z.boolean().default(true),
    hpfHz: z.number().min(20).max(400).default(90),
    eqOn: z.boolean().default(true),
    eq: z.array(bandSchema).length(5).default(DEFAULT_EQ),
    deessOn: z.boolean().default(true),
    deessHz: z.number().min(3000).max(12_000).default(6500),
    deessThresholdDb: z.number().min(-60).max(0).default(-28),
    compOn: z.boolean().default(true),
    compThresholdDb: z.number().min(-60).max(0).default(-20),
    compRatio: z.number().min(1).max(20).default(3),
    compAttackMs: z.number().min(0.1).max(100).default(8),
    compReleaseMs: z.number().min(10).max(1000).default(120),
    compMakeupDb: z.number().min(0).max(24).default(4),
    reverbOn: z.boolean().default(true),
    reverbMix: z.number().min(0).max(1).default(0.15),
    reverbSize: z.number().min(0).max(1).default(0.6),
    reverbDamp: z.number().min(0).max(1).default(0.4),
    delayOn: z.boolean().default(false),
    delayMix: z.number().min(0).max(1).default(0.12),
    delayMs: z.number().min(20).max(1500).default(320),
    delayFeedback: z.number().min(0).max(0.9).default(0.3),
    limiterOn: z.boolean().default(true),
    limiterCeilingDb: z.number().min(-12).max(0).default(-1),
    outputGainDb: z.number().min(-24).max(24).default(0),
});

const voiceSchema = z.object({
    on: z.boolean().default(false),
    degrees: z.number().int().min(-7).max(7).default(2),
    gainDb: z.number().min(-30).max(6).default(-6),
    pan: z.number().min(-1).max(1).default(0),
});

const harmonySchema = z.object({
    voices: z
        .array(voiceSchema)
        .length(3)
        .default([
            { on: false, degrees: 2, gainDb: -6, pan: -0.4 },
            { on: false, degrees: 4, gainDb: -6, pan: 0.4 },
            { on: false, degrees: -3, gainDb: -6, pan: 0 },
        ]),
    double: z.number().min(0).max(1).default(0),
});

const duckSchema = z.object({
    on: z.boolean().default(false),
    depthDb: z.number().min(-30).max(0).default(-8),
    releaseMs: z.number().min(50).max(2000).default(400),
});

export const vocalParamsSchema = z.object({
    bypass: z.boolean().default(false),
    tune: tuneSchema.prefault({}),
    chain: chainSchema.prefault({}),
    harmony: harmonySchema.prefault({}),
    duck: duckSchema.prefault({}),
});
export type VocalParams = z.infer<typeof vocalParamsSchema>;
export type VocalTune = VocalParams["tune"];
export type VocalChain = VocalParams["chain"];

export const vocalSchema = z.object({
    /** Engine running inside Voicemeeter. */
    enabled: z.boolean().default(false),
    /** Voicemeeter strip (0-based) carrying the microphone. */
    micStrip: z.number().int().min(0).max(7).default(0),
    /** Strip carrying music/backing track (key detection + ducking); -1 = none. */
    musicStrip: z.number().int().min(-1).max(7).default(5),
    /** Follow the key detected on the music strip. */
    autoKey: z.boolean().default(false),
    alwaysOnTop: z.boolean().default(true),
    params: vocalParamsSchema.prefault({}),
    /** Second slot for A/B comparison. */
    paramsB: vocalParamsSchema.optional(),
    slot: z.enum(["a", "b"]).default("a"),
});
export type VocalSettings = z.infer<typeof vocalSchema>;

export const VOCAL_PRESETS = ["natural", "pop", "hardTune", "trap", "karaoke", "radio"] as const;
export type VocalPreset = (typeof VOCAL_PRESETS)[number];

type PresetPatch = { tune?: Partial<VocalTune>; chain?: Partial<VocalChain>; harmony?: Partial<VocalParams["harmony"]> };

const PRESET_PATCHES: Record<VocalPreset, PresetPatch> = {
    natural: { tune: { retuneMs: 80, humanize: 0.6, flexCents: 15, vibrato: 1, mode: "natural" }, chain: { reverbMix: 0.12 } },
    pop: { tune: { retuneMs: 25, humanize: 0.3, flexCents: 0, vibrato: 0.8, mode: "live" }, chain: { reverbMix: 0.18, compRatio: 4 } },
    hardTune: { tune: { retuneMs: 0, humanize: 0, flexCents: 0, vibrato: 0, mode: "live" }, chain: { reverbMix: 0.1 } },
    trap: { tune: { retuneMs: 5, humanize: 0, vibrato: 0, mode: "live" }, chain: { delayOn: true, delayMix: 0.18, delayMs: 375, reverbMix: 0.14 } },
    karaoke: { tune: { retuneMs: 60, humanize: 0.5, flexCents: 20, mode: "natural" }, chain: { reverbMix: 0.28, reverbSize: 0.8 } },
    radio: { tune: { enabled: false }, chain: { compRatio: 5, compThresholdDb: -24, reverbMix: 0.05, deessThresholdDb: -32 } },
};

/** Applies a preset over `base`, keeping key/scale and the device-specific bits. */
export function applyVocalPreset(base: VocalParams, preset: VocalPreset): VocalParams {
    const p = PRESET_PATCHES[preset];
    return vocalParamsSchema.parse({
        ...base,
        tune: { ...base.tune, ...p.tune, key: base.tune.key, scale: base.tune.scale },
        chain: { ...base.chain, ...p.chain },
        harmony: { ...base.harmony, ...p.harmony },
    });
}

/** "A minor" / "La minor" style label (names come from the UI locale). */
export function noteName(midi: number): string {
    const n = Math.round(midi);
    return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
