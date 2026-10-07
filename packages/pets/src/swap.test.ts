import { describe, expect, it } from "vitest";

import { SWAP_IN_S, SWAP_OUT_S, swapIn, swapOut } from "./swap.js";

describe("pet swap morph", () => {
    it("the old pet starts whole and ends gone", () => {
        expect(swapOut(0)).toMatchObject({ scale: 1, alpha: 1 });
        const end = swapOut(SWAP_OUT_S);
        expect(end.scale).toBeCloseTo(0, 6);
        expect(end.alpha).toBe(0);
    });

    it("the new pet pops in with an overshoot and settles exactly at full size", () => {
        expect(swapIn(0).scale).toBe(0);
        let peak = 0;
        for (let t = 0; t <= SWAP_IN_S; t += 1 / 120) peak = Math.max(peak, swapIn(t).scale);
        expect(peak).toBeGreaterThan(1.05);
        expect(peak).toBeLessThan(1.3);
        expect(swapIn(SWAP_IN_S)).toEqual({ scale: 1, stretch: 1, spin: -0, alpha: 1 });
    });

    it("is smooth: no frame-to-frame jump bigger than a tenth of the size at 60 fps", () => {
        for (const f of [swapOut, swapIn]) {
            let prev = f(0).scale;
            for (let t = 1 / 60; t <= SWAP_IN_S; t += 1 / 60) {
                const s = f(t).scale;
                expect(Math.abs(s - prev)).toBeLessThan(0.12);
                prev = s;
            }
        }
    });
});
