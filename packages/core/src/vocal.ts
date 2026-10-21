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
    scale: z.enum(VOCAL_SCALES).default("major"),
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
    /** Narrow notches against whine / hum found by calibration (Hz; 0 = unused). */
    notchHz: z.array(z.number().min(0).max(20_000)).length(4).default([0, 0, 0, 0]),
    notchOn: z.boolean().default(true),
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

/* ------------------------------------------------------------------ *
 * Presets per tab (WS30-06): each section owns a slice of the params.
 * ------------------------------------------------------------------ */

export const VOCAL_SECTIONS = ["tune", "voice", "fx", "harmony"] as const;
export type VocalSection = (typeof VOCAL_SECTIONS)[number];

/** Chain fields that belong to the Voice tab (cleanup + tone + dynamics). */
const VOICE_KEYS = [
    "inputGainDb", "gateOn", "gateThresholdDb", "hpfOn", "hpfHz", "eqOn", "eq", "deessOn", "deessHz", "deessThresholdDb",
    "compOn", "compThresholdDb", "compRatio", "compAttackMs", "compReleaseMs", "compMakeupDb", "notchHz", "notchOn",
] as const satisfies readonly (keyof VocalChain)[];
/** Chain fields that belong to the Effects tab. */
const FX_KEYS = [
    "reverbOn", "reverbMix", "reverbSize", "reverbDamp", "delayOn", "delayMix", "delayMs", "delayFeedback",
    "limiterOn", "limiterCeilingDb", "outputGainDb",
] as const satisfies readonly (keyof VocalChain)[];
/** Tune fields a preset carries (key/scale stay with the song, range/sensitivity with the singer's calibration). */
const TUNE_KEYS = [
    "enabled", "retuneMs", "humanize", "flexCents", "vibrato", "vibratoAddCents", "vibratoRateHz", "transpose", "formant", "mode", "mix",
] as const satisfies readonly (keyof VocalTune)[];

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> =>
    Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/** The slice of `p` a section preset stores. */
export function sectionValues(p: VocalParams, section: VocalSection): Record<string, unknown> {
    switch (section) {
        case "tune":
            return pick(p.tune, TUNE_KEYS);
        case "voice":
            return pick(p.chain, VOICE_KEYS);
        case "fx":
            return pick(p.chain, FX_KEYS);
        case "harmony":
            return { voices: p.harmony.voices, double: p.harmony.double, duck: p.duck };
    }
}

/** Applies a stored section slice over `p` (unknown or invalid fields fall back through the schema). */
export function applySection(p: VocalParams, section: VocalSection, values: Record<string, unknown>): VocalParams {
    const v = values as Partial<Record<string, never>>;
    switch (section) {
        case "tune":
            return vocalParamsSchema.parse({ ...p, tune: { ...p.tune, ...pick(v, TUNE_KEYS as readonly string[]) } });
        case "voice":
            return vocalParamsSchema.parse({ ...p, chain: { ...p.chain, ...pick(v, VOICE_KEYS as readonly string[]) } });
        case "fx":
            return vocalParamsSchema.parse({ ...p, chain: { ...p.chain, ...pick(v, FX_KEYS as readonly string[]) } });
        case "harmony": {
            const h = values as { voices?: unknown; double?: unknown; duck?: unknown };
            return vocalParamsSchema.parse({
                ...p,
                harmony: { ...p.harmony, ...(h.voices !== undefined && { voices: h.voices }), ...(h.double !== undefined && { double: h.double }) },
                duck: { ...p.duck, ...(typeof h.duck === "object" && h.duck) },
            });
        }
    }
}

export const vocalUserPresetSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(60),
    section: z.enum(VOCAL_SECTIONS),
    values: z.record(z.string(), z.unknown()),
    createdAt: z.number().int().nonnegative().default(0),
});
export type VocalUserPreset = z.infer<typeof vocalUserPresetSchema>;

/** Built-in presets per section (names are i18n keys `vocal.builtin.<section>.<id>`). */
export const BUILTIN_SECTION_PRESETS: Record<VocalSection, Record<string, Record<string, unknown>>> = {
    tune: {
        natural: { enabled: true, retuneMs: 80, humanize: 0.6, flexCents: 15, vibrato: 1, mode: "natural", transpose: 0 },
        pop: { enabled: true, retuneMs: 25, humanize: 0.3, flexCents: 0, vibrato: 0.8, mode: "live", transpose: 0 },
        hardTune: { enabled: true, retuneMs: 0, humanize: 0, flexCents: 0, vibrato: 0, mode: "live", transpose: 0 },
        off: { enabled: false },
    },
    voice: {
        clean: { gateOn: true, hpfOn: true, hpfHz: 90, compOn: true, compRatio: 3, compThresholdDb: -20, compMakeupDb: 4, deessOn: true, deessThresholdDb: -28 },
        broadcast: { gateOn: true, hpfOn: true, hpfHz: 80, compOn: true, compRatio: 5, compThresholdDb: -24, compMakeupDb: 7, deessOn: true, deessThresholdDb: -32 },
        warm: { eq: DEFAULT_EQ.map((b, i) => (i === 0 ? { ...b, gainDb: 2.5 } : i === 4 ? { ...b, gainDb: 0 } : b)) },
        bright: { eq: DEFAULT_EQ.map((b, i) => (i === 2 ? { ...b, gainDb: 3 } : i === 4 ? { ...b, gainDb: 4 } : b)) },
    },
    fx: {
        dry: { reverbOn: false, delayOn: false },
        room: { reverbOn: true, reverbMix: 0.12, reverbSize: 0.4, reverbDamp: 0.5, delayOn: false },
        hall: { reverbOn: true, reverbMix: 0.28, reverbSize: 0.85, reverbDamp: 0.3, delayOn: false },
        slapback: { reverbOn: true, reverbMix: 0.1, delayOn: true, delayMix: 0.18, delayMs: 110, delayFeedback: 0.1 },
        trap: { reverbOn: true, reverbMix: 0.14, delayOn: true, delayMix: 0.2, delayMs: 375, delayFeedback: 0.35 },
    },
    harmony: {
        off: { voices: [{ on: false, degrees: 2, gainDb: -6, pan: -0.4 }, { on: false, degrees: 4, gainDb: -6, pan: 0.4 }, { on: false, degrees: -3, gainDb: -6, pan: 0 }], double: 0 },
        double: { double: 0.6 },
        thirds: { voices: [{ on: true, degrees: 2, gainDb: -8, pan: -0.5 }, { on: false, degrees: 4, gainDb: -6, pan: 0.4 }, { on: false, degrees: -3, gainDb: -6, pan: 0 }], double: 0.3 },
        choir: { voices: [{ on: true, degrees: 2, gainDb: -9, pan: -0.6 }, { on: true, degrees: 4, gainDb: -10, pan: 0.6 }, { on: true, degrees: -3, gainDb: -12, pan: 0 }], double: 0.4 },
    },
};

/** Full export: every vocal setting plus the user presets, versioned. */
export const vocalExportSchema = z.object({
    kind: z.literal("tiksee-vocal"),
    version: z.literal(1),
    exportedAt: z.number().int().nonnegative(),
    settings: z.lazy(() => vocalSchema),
});
export type VocalExport = z.infer<typeof vocalExportSchema>;

/** Single-preset file (shared between people). */
export const vocalPresetFileSchema = z.object({
    kind: z.literal("tiksee-vocal-preset"),
    version: z.literal(1),
    presets: z.array(vocalUserPresetSchema).min(1).max(200),
});

/** Parses an imported file: a full export or a preset file. Throws a readable error. */
export function parseVocalImport(text: string): { settings?: VocalSettings; presets: VocalUserPreset[] } {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("not a JSON file");
    }
    const full = vocalExportSchema.safeParse(raw);
    if (full.success) return { settings: full.data.settings, presets: full.data.settings.presets };
    const file = vocalPresetFileSchema.safeParse(raw);
    if (file.success) return { presets: file.data.presets };
    throw new Error("not a TikSee vocal export or preset file");
}

export const vocalSchema = z.object({
    /** Engine running inside Voicemeeter. */
    enabled: z.boolean().default(false),
    /** Voicemeeter strip (0-based) carrying the microphone. */
    micStrip: z.number().int().min(0).max(7).default(0),
    /** Which channel of the mic strip carries the voice: an interface's Line In 2 arrives on the right. */
    micChannel: z.enum(["left", "right", "both"]).default("left"),
    /** Strip carrying music/backing track (key detection + ducking); -1 = none. */
    musicStrip: z.number().int().min(-1).max(7).default(5),
    /** Hardware bus with the headphones (1..5 = A1..A5) for the live routing preset. */
    phonesBus: z.number().int().min(1).max(5).default(1),
    /** Follow the key detected on the music strip. */
    autoKey: z.boolean().default(false),
    alwaysOnTop: z.boolean().default(true),
    params: vocalParamsSchema.prefault({}),
    /** Second slot for A/B comparison. */
    paramsB: vocalParamsSchema.optional(),
    slot: z.enum(["a", "b"]).default("a"),
    /** User presets, per tab. */
    presets: z.array(vocalUserPresetSchema).max(200).default([]),
    /** Last calibration (shown in Setup; re-run any time). */
    calibratedAt: z.number().int().nonnegative().default(0),
});
export type VocalSettings = z.infer<typeof vocalSchema>;

/** "A minor" / "La minor" style label (names come from the UI locale). */
export function noteName(midi: number): string {
    const n = Math.round(midi);
    return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
