import type { Rotation } from "./geometry.js";

/**
 * Pure tensor helpers for the ONNX models (no ORT dependency): image -> CHW
 * float input, float16 <-> float32, map rotation back to raw camera space,
 * 2D similarity alignment for face crops.
 */

export const IMAGENET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
export const IMAGENET_STD: [number, number, number] = [0.229, 0.224, 0.225];

export interface ChwOptions {
    /** Channel order of the output planes. */
    order: "RGB" | "BGR";
    /** Multiply 0..255 by this first (1/255 for 0..1 inputs, 1 for 0..255). */
    scale: number;
    mean: [number, number, number];
    std: [number, number, number];
}

/** RGBA pixels (canvas ImageData) -> planar CHW float32: ((v * scale) - mean) / std. */
export function rgbaToChw(rgba: ArrayLike<number>, width: number, height: number, o: ChwOptions): Float32Array {
    const n = width * height;
    const out = new Float32Array(3 * n);
    const src = o.order === "RGB" ? [0, 1, 2] : [2, 1, 0];
    for (let c = 0; c < 3; c++) {
        const ch = src[c] ?? c;
        const m = o.mean[c] ?? 0;
        const s = o.std[c] ?? 1;
        for (let i = 0; i < n; i++) out[c * n + i] = ((rgba[i * 4 + ch] ?? 0) * o.scale - m) / s;
    }
    return out;
}

/** IEEE 754 half-precision bits from a float32 (round to nearest even). */
export function f32ToF16(v: number): number {
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    f[0] = v;
    const x = u[0] ?? 0;
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    const e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign;
        mant |= 0x800000;
        const shift = 14 - e;
        let half = mant >>> shift;
        const rem = mant & ((1 << shift) - 1);
        const mid = 1 << (shift - 1);
        if (rem > mid || (rem === mid && half & 1)) half++;
        return sign | half;
    }
    let half = (e << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
    return sign | half;
}

export function f16ToF32(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 0x1f) return mant ? Number.NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function toF16Array(src: Float32Array): Uint16Array {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = f32ToF16(src[i] ?? 0);
    return out;
}

export function fromF16Array(src: ArrayLike<number>): Float32Array {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = f16ToF32(src[i] ?? 0);
    return out;
}

/**
 * A map computed on the UPRIGHT image (width x height, row-major) -> the same
 * map in RAW camera orientation (the inverse of turning raw by `rotation`
 * clockwise).
 */
export function uprightMapToRaw(data: Float32Array, width: number, height: number, rotation: Rotation): { data: Float32Array; width: number; height: number } {
    if (rotation === 0) return { data, width, height };
    const rw = rotation === 180 ? width : height;
    const rh = rotation === 180 ? height : width;
    const out = new Float32Array(data.length);
    for (let ry = 0; ry < rh; ry++) {
        for (let rx = 0; rx < rw; rx++) {
            // Same mapping as toUpright, in integer pixels.
            let ux: number;
            let uy: number;
            if (rotation === 90) {
                ux = rh - 1 - ry;
                uy = rx;
            } else if (rotation === 180) {
                ux = rw - 1 - rx;
                uy = rh - 1 - ry;
            } else {
                ux = ry;
                uy = rw - 1 - rx;
            }
            out[ry * rw + rx] = data[uy * width + ux] ?? 0;
        }
    }
    return { data: out, width: rw, height: rh };
}

/** Least-squares 2D similarity (scale + rotation + translation) mapping src -> dst. */
export interface Similarity {
    a: number;
    b: number;
    tx: number;
    ty: number;
}

export function similarityTransform(src: readonly [number, number][], dst: readonly [number, number][]): Similarity {
    const n = Math.min(src.length, dst.length);
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        sx += src[i]?.[0] ?? 0;
        sy += src[i]?.[1] ?? 0;
        dx += dst[i]?.[0] ?? 0;
        dy += dst[i]?.[1] ?? 0;
    }
    sx /= n;
    sy /= n;
    dx /= n;
    dy /= n;
    let num1 = 0;
    let num2 = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const x = (src[i]?.[0] ?? 0) - sx;
        const y = (src[i]?.[1] ?? 0) - sy;
        const u = (dst[i]?.[0] ?? 0) - dx;
        const v = (dst[i]?.[1] ?? 0) - dy;
        num1 += x * u + y * v;
        num2 += x * v - y * u;
        den += x * x + y * y;
    }
    const a = den > 0 ? num1 / den : 1;
    const b = den > 0 ? num2 / den : 0;
    return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

export function applySimilarity(t: Similarity, x: number, y: number): [number, number] {
    return [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];
}

/** ArcFace / SFace 112x112 five-point template: eye (image-left), eye (image-right), nose, mouth left, mouth right. */
export const ARCFACE_TEMPLATE: [number, number][] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

/** Variance of a 4-neighbour Laplacian over a grayscale image: a cheap sharpness score. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const l = 4 * (gray[i] ?? 0) - (gray[i - 1] ?? 0) - (gray[i + 1] ?? 0) - (gray[i - width] ?? 0) - (gray[i + width] ?? 0);
            sum += l;
            sum2 += l * l;
            n++;
        }
    if (n === 0) return 0;
    const m = sum / n;
    return sum2 / n - m * m;
}
