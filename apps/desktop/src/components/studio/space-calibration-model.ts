import type { StudioSettings } from "@tiksee/core";

import type { SpaceSample } from "../../lib/studio/controller.js";

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
