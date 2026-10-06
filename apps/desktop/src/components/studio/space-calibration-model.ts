import type { StudioSettings, VisionCalibration } from "@tiksee/core";

import type { HandSample, SpaceSample } from "../../lib/studio/controller.js";

/**
 * Pure logic of the 3D space calibration wizard: camera preset -> vFOV, owner
 * height validation, merging the standing + seated samples and building the
 * settings patch. No React, no I/O (tested in space-calibration-model.test.ts).
 */

export type CameraPresetId = StudioSettings["cameraPreset"];
export type FovSource = StudioSettings["space"]["fovSource"];

type PresetSpec = { vfovDeg: number } | { sensorHeightMm: number; defaultFocalMm: number };

/**
 * Vertical FOV of a 16:9 1080p frame per camera. Mirrors `CAMERA_PRESETS` in
 * packages/pets/src/metric.ts (not exported from the `@tiksee/pets` entry, and
 * the settings window must not pull three.js in for a lookup table).
 */
export const PRESET_SPECS: Readonly<Record<CameraPresetId, PresetSpec>> = {
    "sony-zv-e10": { sensorHeightMm: 13.2, defaultFocalMm: 16 },
    "logitech-c920": { vfovDeg: 43.3 },
    "logitech-brio-90": { vfovDeg: 52.0 },
    "logitech-brio-78": { vfovDeg: 43.3 },
    "logitech-brio-65": { vfovDeg: 35.6 },
    laptop: { vfovDeg: 41.0 },
    custom: { vfovDeg: 45.0 },
};

export const CAMERA_PRESET_IDS = Object.keys(PRESET_SPECS) as CameraPresetId[];

export const VFOV_MIN = 15;
export const VFOV_MAX = 110;
export const LENS_MIN_MM = 8;
export const LENS_MAX_MM = 200;
export const HEIGHT_MIN_CM = 120;
export const HEIGHT_MAX_CM = 220;
export const WORLD_SCALE_MIN = 0.7;
export const WORLD_SCALE_MAX = 1.4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits: number) => {
    const f = 10 ** digits;
    return Math.round(v * f) / f;
};

/** Vertical FOV of a lens on a sensor (same formula as `lensVfov` in @tiksee/pets). */
export function lensVfov(focalMm: number, sensorHeightMm: number): number {
    return (2 * Math.atan(sensorHeightMm / 2 / Math.max(focalMm, 1)) * 180) / Math.PI;
}

/** True when the preset needs a lens focal length (interchangeable-lens cameras). */
export function presetNeedsLens(preset: CameraPresetId): boolean {
    return "sensorHeightMm" in PRESET_SPECS[preset];
}

/** vFOV (deg, 1 decimal) for a preset; `custom` keeps the given (calibrated or typed) value. */
export function presetVfov(preset: CameraPresetId, lensMm: number, customVfovDeg: number): number {
    const spec = PRESET_SPECS[preset];
    if (preset === "custom") return round(clamp(customVfovDeg, VFOV_MIN, VFOV_MAX), 1);
    const deg = "vfovDeg" in spec ? spec.vfovDeg : lensVfov(clamp(lensMm, LENS_MIN_MM, LENS_MAX_MM), spec.sensorHeightMm);
    return round(clamp(deg, VFOV_MIN, VFOV_MAX), 1);
}

/** Camera choice carried through the wizard. */
export interface CameraChoice {
    preset: CameraPresetId;
    lensMm: number;
    vfovDeg: number;
    fovSource: FovSource;
    k1: number;
    k2: number;
}

export function cameraFromStudio(s: StudioSettings): CameraChoice {
    return { preset: s.cameraPreset, lensMm: s.lensMm, vfovDeg: s.vfovDeg, fovSource: s.space.fovSource, k1: s.space.k1, k2: s.space.k2 };
}

/** Switch preset: a preset FOV drops any lens distortion measured for another lens. */
export function choosePreset(current: CameraChoice, preset: CameraPresetId): CameraChoice {
    if (preset === "custom") return { ...current, preset, vfovDeg: presetVfov("custom", current.lensMm, current.vfovDeg) };
    const lensMm = presetNeedsLens(preset) && current.preset !== preset ? lensMmDefault(preset, current.lensMm) : current.lensMm;
    return { preset, lensMm, vfovDeg: presetVfov(preset, lensMm, current.vfovDeg), fovSource: "preset", k1: 0, k2: 0 };
}

function lensMmDefault(preset: CameraPresetId, fallback: number): number {
    const spec = PRESET_SPECS[preset];
    return "defaultFocalMm" in spec ? spec.defaultFocalMm : fallback;
}

export function chooseLens(current: CameraChoice, lensMm: number): CameraChoice {
    const mm = clamp(Math.round(lensMm), LENS_MIN_MM, LENS_MAX_MM);
    return { ...current, lensMm: mm, vfovDeg: presetVfov(current.preset, mm, current.vfovDeg), fovSource: "preset", k1: 0, k2: 0 };
}

/** A measured FOV (ChArUco or MoGe) becomes the `custom` preset. */
export function acceptMeasuredFov(current: CameraChoice, vfovDeg: number, source: "charuco" | "moge" | "manual", k1 = 0, k2 = 0): CameraChoice {
    return { ...current, preset: "custom", vfovDeg: presetVfov("custom", current.lensMm, vfovDeg), fovSource: source, k1, k2 };
}

/** Parse the typed owner height in cm; null when empty or outside 120-220. */
export function parseHeightCm(text: string): number | null {
    const v = Number(text.trim().replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(v) || v < HEIGHT_MIN_CM || v > HEIGHT_MAX_CM) return null;
    return Math.round(v);
}

/** Owner height / MediaPipe world-landmark height, clamped 0.7-1.4; undefined when either is unknown. */
export function worldScaleFrom(heightM: number | undefined, modelHeightM: number | undefined): number | undefined {
    if (!heightM || !modelHeightM || heightM <= 0 || modelHeightM <= 0) return undefined;
    return round(clamp(heightM / modelHeightM, WORLD_SCALE_MIN, WORLD_SCALE_MAX), 3);
}

/** Merged measurement: seated values win for desk metrics, standing for the camera pose. */
export interface SpaceMeasure {
    tiltDeg?: number;
    cameraHeightM?: number;
    distanceM?: number;
    shoulderM?: number;
    irisM?: number;
    seatedHeadM?: number;
    modelHeightM?: number;
}

const usable = (s: SpaceSample | undefined) => (s && s.frames > 0 ? s : undefined);

export function combineSamples(standing: SpaceSample | undefined, seated: SpaceSample | undefined): SpaceMeasure {
    const st = usable(standing);
    const se = usable(seated);
    const out: SpaceMeasure = {};
    const set = <K extends keyof SpaceMeasure>(k: K, v: number | undefined) => {
        if (v !== undefined && Number.isFinite(v)) out[k] = v;
    };
    set("tiltDeg", st?.tiltDeg);
    set("cameraHeightM", st?.heightM);
    set("distanceM", se?.distanceM ?? st?.distanceM);
    set("shoulderM", se?.shoulderM ?? st?.shoulderM);
    set("irisM", se?.irisM ?? st?.irisM);
    set("seatedHeadM", se?.headHeightM);
    // The full body (standing) gives the honest model height; seated legs are folded.
    set("modelHeightM", st?.modelHeightM ?? se?.modelHeightM);
    return out;
}

export interface PatchInput {
    studio: StudioSettings;
    camera: CameraChoice;
    /** Typed owner height in metres (undefined = skipped). */
    heightM: number | undefined;
    measure: SpaceMeasure;
    /** Write the measured tilt / camera height and turn the posture estimate off. */
    useMeasuredTilt: boolean;
    now?: number;
}

/** The settings patch written on Save. Unknown values keep what is already stored. */
export function buildSpacePatch({ studio, camera, heightM, measure, useMeasuredTilt, now = Date.now() }: PatchInput): Partial<StudioSettings> {
    const prev = studio.space;
    const h = heightM ?? (prev.heightM > 0 ? prev.heightM : undefined);
    const patch: Partial<StudioSettings> = {
        cameraPreset: camera.preset,
        lensMm: clamp(Math.round(camera.lensMm), LENS_MIN_MM, LENS_MAX_MM),
        vfovDeg: round(clamp(camera.vfovDeg, VFOV_MIN, VFOV_MAX), 1),
        space: {
            heightM: h !== undefined ? round(clamp(h, 0, 2.5), 2) : prev.heightM,
            shoulderM: measure.shoulderM !== undefined ? round(clamp(measure.shoulderM, 0, 0.7), 3) : prev.shoulderM,
            irisM: measure.irisM !== undefined ? round(clamp(measure.irisM, 0, 0.02), 4) : prev.irisM,
            seatedHeadM: measure.seatedHeadM !== undefined ? round(clamp(measure.seatedHeadM, 0, 2.5), 2) : prev.seatedHeadM,
            worldScale: worldScaleFrom(h, measure.modelHeightM) ?? prev.worldScale,
            fovSource: camera.fovSource,
            k1: camera.k1,
            k2: camera.k2,
            calibratedAt: Math.round(now),
        },
    };
    if (useMeasuredTilt && measure.tiltDeg !== undefined) {
        patch.cameraTiltAuto = false;
        patch.cameraTiltDeg = round(clamp(measure.tiltDeg, -30, 60), 1);
        if (measure.cameraHeightM !== undefined) patch.cameraHeightM = round(clamp(measure.cameraHeightM, 0.3, 3), 2);
    }
    return patch;
}

/* ------------------------------------------------------------------ *
 * Formatting ("—" when unknown)
 * ------------------------------------------------------------------ */

export const DASH = "—";

const num = (v: number, digits: number, locale: string) => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatCm(m: number | undefined, locale = "en"): string {
    return m === undefined || !Number.isFinite(m) ? DASH : `${num(m * 100, 0, locale)} cm`;
}
export function formatMm(m: number | undefined, locale = "en"): string {
    return m === undefined || !Number.isFinite(m) ? DASH : `${num(m * 1000, 1, locale)} mm`;
}
export function formatDeg(deg: number | undefined, locale = "en"): string {
    return deg === undefined || !Number.isFinite(deg) ? DASH : `${num(deg, 1, locale)}°`;
}
export function formatMetres(m: number | undefined, locale = "en"): string {
    return m === undefined || !Number.isFinite(m) ? DASH : `${num(m, 2, locale)} m`;
}

/* ------------------------------------------------------------------ *
 * Hands & gestures step
 * ------------------------------------------------------------------ */

/** Gestures recorded in order; "relaxed" = open, still hand (pinch-off baseline, not a classifier shape). */
export const HAND_TARGETS = ["relaxed", "open_palm", "fist", "pinch", "point_up", "thumb_up", "victory"] as const;
export type HandTarget = (typeof HAND_TARGETS)[number];

export const HAND_EMOJI: Readonly<Record<HandTarget, string>> = {
    relaxed: "🖐️",
    open_palm: "✋",
    fist: "✊",
    pinch: "🤏",
    point_up: "☝️",
    thumb_up: "👍",
    victory: "✌️",
};

export const HAND_RECORD_MS = 1500;
export const HAND_VERIFY_MS = 1000;
/** Pass: the classifier saw the target in >= 60 % of the hand frames ... */
export const HAND_HIT_PASS = 0.6;
/** ... and a hand was in frame for >= 70 % of all frames. */
export const HAND_IN_FRAME_PASS = 0.7;

export type HandVerdict = "pass" | "miss" | "outOfFrame" | "noHand";

export interface HandJudgement {
    verdict: HandVerdict;
    /** hits / handFrames, 0..1 ("relaxed" has no classifier shape: its score is the in-frame rate). */
    hitRate: number;
    /** handFrames / frames, 0..1. */
    inFrameRate: number;
}

export function judgeHandSample(s: HandSample): HandJudgement {
    const inFrameRate = s.frames > 0 ? clamp(s.handFrames / s.frames, 0, 1) : 0;
    const hitRate = s.target === "relaxed" ? inFrameRate : s.handFrames > 0 ? clamp(s.hits / s.handFrames, 0, 1) : 0;
    let verdict: HandVerdict;
    if (s.frames === 0 || s.handFrames === 0) verdict = "noHand";
    else if (inFrameRate < HAND_IN_FRAME_PASS) verdict = "outOfFrame";
    else verdict = hitRate >= HAND_HIT_PASS ? "pass" : "miss";
    return { verdict, hitRate, inFrameRate };
}

export function median(values: readonly number[]): number | undefined {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return undefined;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2;
}

export type HandSamples = Partial<Record<HandTarget, HandSample>>;

export interface HandSummaryRow {
    target: HandTarget;
    /** Recording-pass hit rate (undefined = not recorded). */
    record?: number;
    /** Verify-pass hit rate (undefined = not verified). */
    verify?: number;
    pass: boolean;
}

/** Per-gesture rows + the verify pass rate (share of verified gestures that passed). */
export function summariseHands(record: HandSamples, verify: HandSamples): { rows: HandSummaryRow[]; passRate: number; verified: number } {
    const rows: HandSummaryRow[] = [];
    let verified = 0;
    let passed = 0;
    for (const target of HAND_TARGETS) {
        const r = record[target];
        const v = verify[target];
        const row: HandSummaryRow = { target, pass: false };
        if (r) row.record = judgeHandSample(r).hitRate;
        if (v) {
            const j = judgeHandSample(v);
            row.verify = j.hitRate;
            row.pass = j.verdict === "pass";
            verified++;
            if (row.pass) passed++;
        }
        rows.push(row);
    }
    return { rows, passRate: verified > 0 ? passed / verified : 0, verified };
}

export type HandsCalibration = VisionCalibration["hands"];

/** Personal score threshold for a gesture from its median classifier confidence. */
export function gestureThreshold(confidence: number): number {
    return round(clamp(confidence * 0.8, 0.35, 0.8), 3);
}

/** Pinch start ratio from the pinch recording (thumb-index / palm width, 90th percentile). */
export function pinchOnFrom(pinchP90: number): number {
    return round(clamp(pinchP90 * 1.25, 0.1, 0.35), 3);
}

/** Pinch end ratio: hysteresis above `pinchOn`, from the relaxed hand's 10th percentile when known. */
export function pinchOffFrom(pinchOn: number, relaxedP10: number | undefined, fallback: number): number {
    const base = relaxedP10 !== undefined && relaxedP10 > 0 ? clamp(relaxedP10 * 0.8, 0.2, 0.8) : fallback;
    return round(clamp(Math.max(pinchOn + 0.12, base), 0.12, 0.9), 3);
}

/**
 * The `vision.calibration.hands` value written on Save. Gestures not recorded keep their
 * stored thresholds; `now` is a parameter so the caller stamps it at save time.
 */
export function buildHandsCalibration(prev: HandsCalibration, record: HandSamples, verify: HandSamples, now: number = Date.now()): HandsCalibration {
    const both = (t: HandTarget) => [record[t], verify[t]].filter((s): s is HandSample => s !== undefined);
    const palms = [...both("relaxed"), ...both("open_palm")].map((s) => s.palmM).filter((m) => m > 0);
    const palmM = median(palms);
    const pinch = record.pinch ?? verify.pinch;
    const relaxed = record.relaxed ?? verify.relaxed;
    const pinchOn = pinch && pinch.handFrames > 0 ? pinchOnFrom(pinch.pinchP90) : prev.pinchOn;
    const pinchOff = pinchOffFrom(pinchOn, relaxed && relaxed.handFrames > 0 ? relaxed.pinchP10 : undefined, prev.pinchOff);
    const gestures: Record<string, number> = { ...prev.gestures };
    const verified: Record<string, number> = { ...prev.verified };
    for (const target of HAND_TARGETS) {
        if (target === "relaxed") continue;
        const confidences = both(target)
            .filter((s) => s.hits > 0)
            .map((s) => s.confidence);
        const c = median(confidences);
        if (c !== undefined) gestures[target] = gestureThreshold(c);
        const v = verify[target];
        if (v) verified[target] = round(judgeHandSample(v).hitRate, 3);
    }
    return {
        // No depth-backed palm sample = 0 (MediaPipe's average hand).
        palmM: palmM !== undefined ? round(clamp(palmM, 0, 0.15), 4) : 0,
        pinchOn,
        pinchOff,
        gestures,
        verified,
        calibratedAt: Math.round(now),
    };
}

export const formatPct = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? DASH : `${Math.round(v * 100)}%`);
