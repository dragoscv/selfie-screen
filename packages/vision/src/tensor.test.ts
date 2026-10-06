import { describe, expect, it } from "vitest";

import { toUpright } from "./geometry.js";
import {
    applySimilarity,
    ARCFACE_TEMPLATE,
    f16ToF32,
    f32ToF16,
    laplacianVariance,
    rgbaToChw,
    similarityTransform,
    uprightMapToRaw,
} from "./tensor.js";

describe("tensor helpers", () => {
    it("packs RGBA into CHW with channel order and normalisation", () => {
        const rgba = [10, 20, 30, 255, 40, 50, 60, 255];
        const rgb = rgbaToChw(rgba, 2, 1, { order: "RGB", scale: 1, mean: [0, 0, 0], std: [1, 1, 1] });
        expect(Array.from(rgb)).toEqual([10, 40, 20, 50, 30, 60]);
        const bgr = rgbaToChw(rgba, 2, 1, { order: "BGR", scale: 1 / 10, mean: [1, 1, 1], std: [2, 2, 2] });
        expect(Array.from(bgr)).toEqual([1, 2.5, 0.5, 2, 0, 1.5]);
    });

    it("round-trips float16", () => {
        for (const v of [0, 1, -2, 0.5, 3.140625, 65504, 1e-5]) expect(f16ToF32(f32ToF16(v))).toBeCloseTo(v, 3);
        expect(f16ToF32(f32ToF16(1e6))).toBe(Infinity);
    });

    it("maps an upright map back to raw orientation for every rotation", () => {
        // raw 3x2 grid with values = index; build its upright version via toUpright, then invert.
        const rw = 3;
        const rh = 2;
        for (const r of [0, 90, 180, 270] as const) {
            const uw = r === 90 || r === 270 ? rh : rw;
            const uh = r === 90 || r === 270 ? rw : rh;
            const up = new Float32Array(rw * rh);
            for (let y = 0; y < rh; y++)
                for (let x = 0; x < rw; x++) {
                    const [u, v] = toUpright(r, (x + 0.5) / rw, (y + 0.5) / rh);
                    up[Math.floor(v * uh) * uw + Math.floor(u * uw)] = y * rw + x;
                }
            const raw = uprightMapToRaw(up, uw, uh, r);
            expect([raw.width, raw.height]).toEqual([rw, rh]);
            expect(Array.from(raw.data)).toEqual([0, 1, 2, 3, 4, 5]);
        }
    });

    it("finds the similarity that maps five face points onto the template", () => {
        const s = 2.5;
        const a = 0.3;
        const src = ARCFACE_TEMPLATE.map(([x, y]) => [((x - 20) * Math.cos(a) + (y - 5) * Math.sin(a)) * s, (-(x - 20) * Math.sin(a) + (y - 5) * Math.cos(a)) * s] as [number, number]);
        const t = similarityTransform(src, ARCFACE_TEMPLATE);
        for (let i = 0; i < 5; i++) {
            const [x, y] = applySimilarity(t, src[i]?.[0] ?? 0, src[i]?.[1] ?? 0);
            expect(x).toBeCloseTo(ARCFACE_TEMPLATE[i]?.[0] ?? 0, 6);
            expect(y).toBeCloseTo(ARCFACE_TEMPLATE[i]?.[1] ?? 0, 6);
        }
    });

    it("scores a sharp checkerboard above a flat image", () => {
        const w = 8;
        const flat = new Array<number>(64).fill(128);
        const board = Array.from({ length: 64 }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0);
        expect(laplacianVariance(flat, w, w)).toBe(0);
        expect(laplacianVariance(board, w, w)).toBeGreaterThan(1000);
    });
});
