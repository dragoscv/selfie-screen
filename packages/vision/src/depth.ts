import type { VisionCalibration } from "@tiksee/core";

/**
 * Body-scale distance: a pinhole camera makes apparent size inversely
 * proportional to distance, so z = referenceM · sizePx0 / sizePx. The
 * calibration stores `shoulderPx` / `ipdPx` measured at `referenceM`, in
 * upright camera pixels at full camera resolution — the same unit callers
 * must pass here.
 */

/** Minimal One-Euro filter (Casiez et al. 2012); kept local so this package stays dependency-free. */
export class OneEuroFilter {
    #x: number | null = null;
    #dx = 0;
    #t = 0;

    constructor(
        readonly minCutoff = 0.8,
        readonly beta = 0.4,
        readonly dCutoff = 1,
    ) {}

    filter(v: number, tMs: number): number {
        if (this.#x === null) {
            this.#x = v;
            this.#t = tMs;
            return v;
        }
        const dt = Math.max((tMs - this.#t) / 1000, 1e-3);
        this.#t = tMs;
        const a = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
        const dx = (v - this.#x) / dt;
        this.#dx += a(this.dCutoff) * (dx - this.#dx);
        this.#x += a(this.minCutoff + this.beta * Math.abs(this.#dx)) * (v - this.#x);
        return this.#x;
    }

    reset(): void {
        this.#x = null;
        this.#dx = 0;
    }
}

export interface ScaleCue {
    /** Measured size in px (0 = missing). */
    px: number;
    /** 0..1 how much to trust it (landmark visibility). */
    weight: number;
}

type Cal = Pick<VisionCalibration, "shoulderPx" | "ipdPx" | "referenceM">;

/** Fuse shoulder and IPD cues into one distance in metres, or null when uncalibrated / unseen. */
export function bodyScaleDistance(cal: Cal, shoulder: ScaleCue, ipd: ScaleCue): number | null {
    let num = 0;
    let den = 0;
    const add = (ref: number, cue: ScaleCue, trust: number) => {
        if (ref <= 0 || cue.px <= 0 || cue.weight <= 0) return;
        const w = cue.weight * trust;
        num += w * ((cal.referenceM * ref) / cue.px);
        den += w;
    };
    // Shoulders are a larger, steadier baseline; IPD covers close-ups and turned shoulders.
    add(cal.shoulderPx, shoulder, 1);
    add(cal.ipdPx, ipd, 0.6);
    return den > 0 ? num / den : null;
}

export class DistanceEstimator {
    readonly #f = new OneEuroFilter();
    #cal: Cal;

    constructor(cal: Cal) {
        this.#cal = cal;
    }

    setCalibration(cal: Cal): void {
        this.#cal = cal;
        this.#f.reset();
    }

    update(shoulder: ScaleCue, ipd: ScaleCue, tMs: number): number | null {
        const z = bodyScaleDistance(this.#cal, shoulder, ipd);
        if (z === null) return null;
        return this.#f.filter(Math.min(Math.max(z, 0.2), 15), tMs);
    }

    reset(): void {
        this.#f.reset();
    }
}

export interface DepthMap {
    data: Float32Array;
    width: number;
    height: number;
}

/** Normalise any relative map to 0..1 in place-free fashion (min/max). */
export function normaliseDepth(map: DepthMap): DepthMap {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of map.data) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const out = new Float32Array(map.data.length);
    for (let i = 0; i < out.length; i++) out[i] = ((map.data[i] ?? lo) - lo) / span;
    return { data: out, width: map.width, height: map.height };
}

export interface DepthAnchor {
    /** Normalised (0..1) position in the map of a pixel with a known distance (the owner's face). */
    u: number;
    v: number;
    distanceM: number;
}

/**
 * Convert a relative inverse-depth map (larger = nearer, 0..1) to metres with
 * one anchor: inverse depth is affine in 1/z; with a single anchor we assume
 * zero shift, so z(p) = z_anchor · d_anchor / d(p). Values are clamped to
 * [0.2, maxM]. Returns null when the anchor pixel carries no signal.
 */
export function scaleDepthMap(relative: DepthMap, anchor: DepthAnchor, maxM = 15): DepthMap | null {
    const { width, height, data } = relative;
    const cx = Math.min(width - 1, Math.max(0, Math.round(anchor.u * (width - 1))));
    const cy = Math.min(height - 1, Math.max(0, Math.round(anchor.v * (height - 1))));
    // Median of a 3x3 patch: robust to an edge pixel.
    const patch: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && y >= 0 && x < width && y < height) patch.push(data[y * width + x] ?? 0);
        }
    patch.sort((a, b) => a - b);
    const dAnchor = patch[Math.floor(patch.length / 2)] ?? 0;
    if (dAnchor <= 1e-4) return null;
    const k = anchor.distanceM * dAnchor;
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const d = data[i] ?? 0;
        out[i] = d > 1e-4 ? Math.min(maxM, Math.max(0.2, k / d)) : maxM;
    }
    return { data: out, width, height };
}
