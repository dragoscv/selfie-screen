import { beautySchema } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { lipColor } from "./beauty-color.js";
import { FACE_OVAL, FACE_TRIANGLES, LEFT_BROW, LEFT_EYE, LIPS_INNER, LIPS_OUTER, RIGHT_BROW, RIGHT_EYE } from "./face-regions.js";

describe("beauty face regions", () => {
    it("has closed region loops with valid landmark ids", () => {
        for (const loop of [FACE_OVAL, LIPS_OUTER, LIPS_INNER, LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW]) {
            expect(loop.length).toBeGreaterThanOrEqual(8);
            expect(new Set(loop).size).toBe(loop.length);
            for (const id of loop) {
                expect(id).toBeGreaterThanOrEqual(0);
                expect(id).toBeLessThan(478);
            }
        }
    });

    it("covers the face with mesh triangles", () => {
        expect(FACE_TRIANGLES.length % 3).toBe(0);
        expect(FACE_TRIANGLES.length / 3).toBeGreaterThan(800);
    });

    it("lips inner loop sits inside the outer one (different landmarks)", () => {
        expect(LIPS_INNER.some((i) => LIPS_OUTER.includes(i))).toBe(false);
    });
});

describe("beauty settings and colours", () => {
    it("defaults are off and shape is untouched", () => {
        const b = beautySchema.parse({});
        expect(b.enabled).toBe(false);
        expect(b.shape).toEqual({ slim: 0, jaw: 0, nose: 0, chin: 0 });
    });

    it("lip colour stays a muted, valid RGB around the hue wheel", () => {
        for (let h = 0; h <= 1; h += 0.1) {
            const c = lipColor(h);
            for (const v of c) {
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(1);
            }
            // Muted: never a fully saturated primary.
            expect(Math.max(...c) - Math.min(...c)).toBeLessThan(0.5);
        }
        const red = lipColor(0);
        expect(red[0]).toBeGreaterThan(red[1]);
    });
});
