import { beautySchema } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { lipColor } from "./beauty-color.js";
import { anchorsFrom } from "./beauty.js";
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

describe("beauty anchors", () => {
    /** A face whose landmarks all sit on a circle of `rH` output heights around (0.5, 0.4). */
    function roundFace(aspect: number, rH: number): Float32Array {
        const uvs = new Float32Array(478 * 2);
        for (let i = 0; i < 478; i++) {
            const a = (i / 478) * Math.PI * 2;
            uvs[i * 2] = 0.5 + (Math.cos(a) * rH) / aspect;
            uvs[i * 2 + 1] = 0.4 + Math.sin(a) * rH;
        }
        // Face edges (234 left, 454 right) at +-rH horizontally, in output-height units.
        uvs[234 * 2] = 0.5 - rH / aspect;
        uvs[234 * 2 + 1] = 0.4;
        uvs[454 * 2] = 0.5 + rH / aspect;
        uvs[454 * 2 + 1] = 0.4;
        return uvs;
    }

    it("measures the face width in output-height units in portrait and landscape", () => {
        for (const aspect of [9 / 16, 16 / 9]) {
            const a = anchorsFrom(roundFace(aspect, 0.1), aspect, 1);
            expect(a.faceW).toBeCloseTo(0.2, 3);
            expect(Math.abs(a.centre[0] - 0.5)).toBeLessThan(0.1 / aspect);
        }
    });

    it("gives the same eye radius for the same face whatever the output aspect", () => {
        const portrait = anchorsFrom(roundFace(9 / 16, 0.1), 9 / 16, 1);
        const landscape = anchorsFrom(roundFace(16 / 9, 0.1), 16 / 9, 1);
        expect(portrait.eyeL[2]).toBeCloseTo(landscape.eyeL[2], 4);
        expect(portrait.warpGain).toBe(1);
    });
});
