import { describe, expect, it } from "vitest";

import { bodyScaleDistance, DistanceEstimator, normaliseDepth, scaleDepthMap } from "./depth.js";

const CAL = { shoulderPx: 400, ipdPx: 120, referenceM: 1 };

describe("body-scale distance", () => {
    it("is inversely proportional to apparent size", () => {
        expect(bodyScaleDistance(CAL, { px: 400, weight: 1 }, { px: 0, weight: 0 })).toBeCloseTo(1);
        expect(bodyScaleDistance(CAL, { px: 200, weight: 1 }, { px: 0, weight: 0 })).toBeCloseTo(2);
        expect(bodyScaleDistance(CAL, { px: 0, weight: 0 }, { px: 60, weight: 1 })).toBeCloseTo(2);
    });

    it("fuses cues by weight", () => {
        const z = bodyScaleDistance(CAL, { px: 400, weight: 1 }, { px: 60, weight: 1 });
        // shoulder says 1 m (w 1), ipd says 2 m (w 0.6) -> 1.375
        expect(z).toBeCloseTo(1.375);
    });

    it("returns null when uncalibrated or unseen", () => {
        expect(bodyScaleDistance({ shoulderPx: 0, ipdPx: 0, referenceM: 1 }, { px: 400, weight: 1 }, { px: 60, weight: 1 })).toBeNull();
        expect(bodyScaleDistance(CAL, { px: 400, weight: 0 }, { px: 0, weight: 1 })).toBeNull();
    });

    it("smooths jitter with the One-Euro filter", () => {
        const e = new DistanceEstimator(CAL);
        let last = 0;
        for (let t = 0; t < 2000; t += 33) last = e.update({ px: t % 66 ? 380 : 420, weight: 1 }, { px: 0, weight: 0 }, t) ?? 0;
        expect(Math.abs(last - 1)).toBeLessThan(0.03);
    });
});

describe("depth maps", () => {
    it("normalises a relative map to 0..1", () => {
        const n = normaliseDepth({ data: new Float32Array([2, 4, 6, 10]), width: 2, height: 2 });
        expect(Array.from(n.data)).toEqual([0, 0.25, 0.5, 1]);
    });

    it("scales inverse depth to metres from the face anchor", () => {
        // Face pixel inverse depth 0.8 at 1 m; a pixel with 0.4 is twice as far.
        const map = { data: new Float32Array([0.8, 0.8, 0.4, 0.8, 0.8, 0.4, 0.8, 0.8, 0.4]), width: 3, height: 3 };
        const m = scaleDepthMap(map, { u: 0, v: 0.5, distanceM: 1 });
        expect(m?.data[0]).toBeCloseTo(1);
        expect(m?.data[2]).toBeCloseTo(2);
    });

    it("returns null for an empty anchor and clamps far values", () => {
        expect(scaleDepthMap({ data: new Float32Array(9), width: 3, height: 3 }, { u: 0.5, v: 0.5, distanceM: 1 })).toBeNull();
        const m = scaleDepthMap({ data: new Float32Array([1, 1, 1, 1, 0.001, 1, 1, 1, 1]), width: 3, height: 3 }, { u: 0, v: 0, distanceM: 1 }, 10);
        expect(m?.data[4]).toBe(10);
    });
});
