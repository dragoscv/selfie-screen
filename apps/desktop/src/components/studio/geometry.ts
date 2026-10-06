import type { StudioSettings, VisionCalibration } from "@tiksee/core";

import type { CalibrationSample, FaceBox } from "../../lib/studio/controller.js";

/** Pure maths shared by the studio overlays (unit-tested, no DOM). */

/** The owner's face, else the first one. */
export const ownerFaceOf = (faces: readonly FaceBox[]): FaceBox | undefined => faces.find((f) => f.owner) ?? faces[0];

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface NormBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Where an `object-fit: contain` image of `contentW x contentH` lands inside a `boxW x boxH` element. */
export function containRect(boxW: number, boxH: number, contentW: number, contentH: number): Rect {
    if (boxW <= 0 || boxH <= 0 || contentW <= 0 || contentH <= 0) return { left: 0, top: 0, width: 0, height: 0 };
    const scale = Math.min(boxW / contentW, boxH / contentH);
    const width = contentW * scale;
    const height = contentH * scale;
    return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/** Element-local point -> output-normalised coords (may fall outside 0..1). */
export function toNormalised(rect: Rect, localX: number, localY: number): [number, number] {
    if (rect.width <= 0 || rect.height <= 0) return [0.5, 0.5];
    return [(localX - rect.left) / rect.width, (localY - rect.top) / rect.height];
}

export function sameRect(a: Rect, b: Rect): boolean {
    return (
        Math.abs(a.left - b.left) < 0.5 &&
        Math.abs(a.top - b.top) < 0.5 &&
        Math.abs(a.width - b.width) < 0.5 &&
        Math.abs(a.height - b.height) < 0.5
    );
}

/* ------------------------------------------------------------------ *
 * Depth ruler: log scale between the AR depth limits.
 * ------------------------------------------------------------------ */

export const DEPTH_MIN_M = 0.3;
export const DEPTH_MAX_M = 6;
const DEPTH_SPAN = Math.log(DEPTH_MAX_M / DEPTH_MIN_M);

/** Metres -> 0 (near) .. 1 (far) on the ruler. */
export function depthToPos(m: number): number {
    return Math.log(clamp(m, DEPTH_MIN_M, DEPTH_MAX_M) / DEPTH_MIN_M) / DEPTH_SPAN;
}

/** 0 (near) .. 1 (far) -> metres, rounded to centimetres. */
export function posToDepth(p: number): number {
    return Math.round(DEPTH_MIN_M * Math.exp(clamp(p, 0, 1) * DEPTH_SPAN) * 100) / 100;
}

/** One wheel notch moves a constant ratio, so near objects move in small steps and far ones in big steps. */
export function stepDepth(m: number, notches: number): number {
    return posToDepth(depthToPos(m) + notches * 0.025);
}

/* ------------------------------------------------------------------ *
 * Framing guides.
 * ------------------------------------------------------------------ */

export function guideLines(kind: StudioSettings["monitor"]["guides"]): { xs: number[]; ys: number[] } {
    switch (kind) {
        case "thirds":
            return { xs: [1 / 3, 2 / 3], ys: [1 / 3, 2 / 3] };
        case "golden":
            return { xs: [0.382, 0.618], ys: [0.382, 0.618] };
        case "grid":
            return { xs: [0.25, 0.5, 0.75], ys: [0.25, 0.5, 0.75] };
        case "center":
            return { xs: [0.5], ys: [0.5] };
        default:
            return { xs: [], ys: [] };
    }
}

/* ------------------------------------------------------------------ *
 * TikTok LIVE safe zones (estimated on a 1080x1920 portrait frame).
 * ------------------------------------------------------------------ */

export type SafeZoneId = "top" | "comments" | "bottom" | "rail" | "title";

export interface SafeZone extends NormBox {
    id: SafeZoneId;
}

const PORTRAIT_W = 1080;
const PORTRAIT_H = 1920;
const PORTRAIT_ZONES_PX: readonly { id: SafeZoneId; x0: number; y0: number; x1: number; y1: number }[] = [
    { id: "top", x0: 0, y0: 0, x1: 1080, y1: 230 },
    { id: "comments", x0: 0, y0: 1150, x1: 780, y1: 1700 },
    { id: "bottom", x0: 0, y0: 1700, x1: 1080, y1: 1920 },
    { id: "rail", x0: 930, y0: 1300, x1: 1080, y1: 1920 },
];

export const PORTRAIT_SAFE_ZONES: readonly SafeZone[] = PORTRAIT_ZONES_PX.map((z) => ({
    id: z.id,
    x: z.x0 / PORTRAIT_W,
    y: z.y0 / PORTRAIT_H,
    w: (z.x1 - z.x0) / PORTRAIT_W,
    h: (z.y1 - z.y0) / PORTRAIT_H,
}));

/** Landscape: only a generic 5 % title-safe inset (drawn as an outline). */
export const LANDSCAPE_TITLE_SAFE: SafeZone = { id: "title", x: 0.05, y: 0.05, w: 0.9, h: 0.9 };

/** Share of `a`'s area covered by `b` (0..1). */
export function overlapShare(a: NormBox, b: NormBox): number {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const area = a.w * a.h;
    return w <= 0 || h <= 0 || area <= 0 ? 0 : (w * h) / area;
}

/** The comments/bottom zone the owner's face sits under, if more than `minShare` of it is covered. */
export function guardianZone(
    face: NormBox | undefined,
    orientation: StudioSettings["orientation"],
    minShare = 0.1,
): "comments" | "bottom" | null {
    if (!face || orientation !== "portrait") return null;
    let best: "comments" | "bottom" | null = null;
    let bestShare = minShare;
    for (const zone of PORTRAIT_SAFE_ZONES) {
        if (zone.id !== "comments" && zone.id !== "bottom") continue;
        const share = overlapShare(face, zone);
        if (share > bestShare) {
            bestShare = share;
            best = zone.id;
        }
    }
    return best;
}

/* ------------------------------------------------------------------ *
 * Exposure assistant.
 * ------------------------------------------------------------------ */

export const FACE_IRE_LOW = 60;
export const FACE_IRE_HIGH = 70;

export function exposureAdvice(ire: number): "under" | "over" | "good" {
    if (ire < FACE_IRE_LOW) return "under";
    if (ire > FACE_IRE_HIGH) return "over";
    return "good";
}

/** Stops to the middle of the target band (positive = brighten). */
export function exposureCorrection(ire: number): number {
    const target = (FACE_IRE_LOW + FACE_IRE_HIGH) / 2;
    return Math.round(Math.log2(target / Math.max(ire, 1)) * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * Perf readout.
 * ------------------------------------------------------------------ */

const DETECTOR_TASKS = ["pose", "hands", "face", "objects", "depth"] as const;

/**
 * Per-frame vision latency in ms. Prefers the pipeline's own `total`; else the
 * sum of the detector tasks. Never adds one-off model loads (`load.*`),
 * counters (`vcamDropped`) or flags (`mode.worker`) — that showed "773 ms"
 * while the real per-frame cost was ~18 ms (2026-10-06).
 */
export function visionLatency(visionMs: Readonly<Record<string, number>>): number {
    const total = visionMs["total"];
    if (total !== undefined) return total;
    let sum = 0;
    for (const key of DETECTOR_TASKS) sum += visionMs[key] ?? 0;
    return sum;
}

/* ------------------------------------------------------------------ *
 * Calibration maths.
 * ------------------------------------------------------------------ */

export interface CalibrationSet {
    baseline: CalibrationSample;
    leftClosed: CalibrationSample;
    rightClosed: CalibrationSample;
    smile: CalibrationSample;
    mouthOpen: CalibrationSample;
    browsUp: CalibrationSample;
    posture: CalibrationSample;
}

/** Threshold 60 % of the way from the relaxed value to the acted value, clamped to the schema range. */
export function threshold(relaxed: number, acted: number, k = 0.6): number {
    const t = relaxed + k * (acted - relaxed);
    return Math.round(clamp(t, 0.1, 0.95) * 1000) / 1000;
}

/**
 * The prompt "close your LEFT eye" should move the `blinkLeft` blendshape.
 * If it moved `blinkRight` more, the image is mirrored relative to the
 * blendshape naming and the runtime must swap the eyes.
 */
export function detectSwapEyes(s: Pick<CalibrationSet, "baseline" | "leftClosed">): boolean {
    const own = s.leftClosed.blinkLeft - s.baseline.blinkLeft;
    const other = s.leftClosed.blinkRight - s.baseline.blinkRight;
    return other > own;
}

export function computeCalibration(s: CalibrationSet, referenceM: number, now: number): VisionCalibration {
    const swapEyes = detectSwapEyes(s);
    // Each blendshape channel is thresholded against the prompt that actually closed it.
    const leftChannelClosed = swapEyes ? s.rightClosed.blinkLeft : s.leftClosed.blinkLeft;
    const rightChannelClosed = swapEyes ? s.leftClosed.blinkRight : s.rightClosed.blinkRight;
    return {
        blinkLeft: threshold(s.baseline.blinkLeft, leftChannelClosed),
        blinkRight: threshold(s.baseline.blinkRight, rightChannelClosed),
        smile: threshold(s.baseline.smile, s.smile.smile),
        mouthOpen: threshold(s.baseline.mouthOpen, s.mouthOpen.mouthOpen),
        browsUp: threshold(s.baseline.browsUp, s.browsUp.browsUp),
        shoulderPx: Math.max(0, Math.round(s.posture.shoulderPx)),
        ipdPx: Math.max(0, Math.round(s.posture.ipdPx * 10) / 10),
        neckRatio: Math.max(0, Math.round(s.posture.neckRatio * 1000) / 1000),
        referenceM: clamp(referenceM, 0.3, 4),
        swapEyes,
        calibratedAt: Math.round(now),
    };
}
