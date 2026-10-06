/**
 * Shared 2D geometry for the classifiers.
 *
 * Coordinate convention for every analyser in this package ("display space"):
 * the raw camera frame turned upright (`rotation`) and flipped when the preview
 * is mirrored, in upright camera PIXELS (full camera resolution), y down. So
 * "left/right" in gesture ids (point_left, swipe_right, tilt_left) are the
 * directions the streamer sees on their own preview.
 */
export interface Pt {
    x: number;
    y: number;
    z?: number;
    visibility?: number;
}

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Degrees clockwise to turn the raw camera image upright. */
export type Rotation = 0 | 90 | 180 | 270;

const ZERO: Pt = { x: 0, y: 0, z: 0, visibility: 0 };

/** Safe indexed access for landmark arrays under noUncheckedIndexedAccess. */
export function at(points: readonly Pt[], i: number): Pt {
    return points[i] ?? ZERO;
}

/** Raw normalised camera point -> upright normalised point (y down). */
export function toUpright(rotation: Rotation, x: number, y: number): [number, number] {
    switch (rotation) {
        case 90:
            return [1 - y, x];
        case 180:
            return [1 - x, 1 - y];
        case 270:
            return [y, 1 - x];
        default:
            return [x, y];
    }
}

/** Upright frame size for a raw camera size. */
export function uprightSize(rotation: Rotation, w: number, h: number): [number, number] {
    return rotation === 90 || rotation === 270 ? [h, w] : [w, h];
}

/** Inverse of toUpright: upright normalised point -> raw normalised camera point. */
export function fromUpright(rotation: Rotation, u: number, v: number): [number, number] {
    switch (rotation) {
        case 90:
            return [v, 1 - u];
        case 180:
            return [1 - u, 1 - v];
        case 270:
            return [1 - v, u];
        default:
            return [u, v];
    }
}

/** Upright normalised box -> raw normalised box (axis-aligned bounds of the rotated corners). */
export function boxFromUpright(rotation: Rotation, b: Box): Box {
    const [x1, y1] = fromUpright(rotation, b.x, b.y);
    const [x2, y2] = fromUpright(rotation, b.x + b.w, b.y + b.h);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/**
 * Raw normalised camera point -> display-space pixels: upright, mirrored when the
 * preview is mirrored, scaled by the upright camera size.
 */
export function toDisplay(rotation: Rotation, mirror: boolean, x: number, y: number, uprightW: number, uprightH: number): [number, number] {
    const [ux, uy] = toUpright(rotation, x, y);
    return [(mirror ? 1 - ux : ux) * uprightW, uy * uprightH];
}

export function dist(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function mid(a: Pt, b: Pt): Pt {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function mean(points: readonly Pt[]): Pt {
    if (points.length === 0) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const p of points) {
        x += p.x;
        y += p.y;
    }
    return { x: x / points.length, y: y / points.length };
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(a: number): number {
    let r = a;
    while (r > Math.PI) r -= 2 * Math.PI;
    while (r <= -Math.PI) r += 2 * Math.PI;
    return r;
}

export function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function iou(a: Box, b: Box): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}

export function boxCentre(b: Box): Pt {
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Bounding box of the points whose visibility is at least `minVis` (missing visibility counts as visible). */
export function boxOfPoints(points: readonly Pt[], minVis = 0.5): Box | null {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const p of points) {
        if ((p.visibility ?? 1) < minVis) continue;
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
    }
    return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/** Population standard deviation. */
export function stddev(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const m = values.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

/**
 * Count direction reversals in a 1-D series, ignoring wiggles smaller than
 * `amplitude` (a reversal needs the value to come back by at least that much
 * from the last extreme).
 */
export function countReversals(values: readonly number[], amplitude: number): number {
    if (values.length < 2) return 0;
    const first = values[0] ?? 0;
    let hi = first;
    let lo = first;
    let extreme = first;
    let dir = 0;
    let reversals = 0;
    for (const v of values) {
        if (dir === 0) {
            // No direction yet: wait for the first move of at least `amplitude` either way.
            hi = Math.max(hi, v);
            lo = Math.min(lo, v);
            if (v - lo >= amplitude) {
                dir = 1;
                extreme = v;
            } else if (hi - v >= amplitude) {
                dir = -1;
                extreme = v;
            }
        } else if (dir > 0) {
            if (v > extreme) extreme = v;
            else if (extreme - v >= amplitude) {
                reversals++;
                dir = -1;
                extreme = v;
            }
        } else if (v < extreme) extreme = v;
        else if (v - extreme >= amplitude) {
            reversals++;
            dir = 1;
            extreme = v;
        }
    }
    return reversals;
}
