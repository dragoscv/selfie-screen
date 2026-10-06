import { describe, expect, it } from "vitest";

import type { CalibrationSample } from "../../lib/studio/controller.js";
import {
    DEPTH_MAX_M,
    DEPTH_MIN_M,
    PORTRAIT_SAFE_ZONES,
    computeCalibration,
    containRect,
    depthToPos,
    detectSwapEyes,
    exposureAdvice,
    exposureCorrection,
    guardianZone,
    overlapShare,
    posToDepth,
    stepDepth,
    threshold,
    toNormalised,
    visionLatency,
} from "./geometry.js";

describe("containRect", () => {
    it("letterboxes a portrait frame in a landscape window", () => {
        expect(containRect(1920, 1080, 1080, 1920)).toEqual({ left: 656.25, top: 0, width: 607.5, height: 1080 });
    });

    it("pillarboxes a landscape frame in a tall window", () => {
        const r = containRect(1000, 1000, 1920, 1080);
        expect(r.width).toBeCloseTo(1000);
        expect(r.height).toBeCloseTo(562.5);
        expect(r.top).toBeCloseTo(218.75);
    });

    it("returns an empty rect for zero sizes", () => {
        expect(containRect(0, 100, 1080, 1920).width).toBe(0);
    });

    it("maps element-local points back to output-normalised coords", () => {
        const r = containRect(1920, 1080, 1080, 1920);
        expect(toNormalised(r, r.left + r.width / 2, r.height / 4)).toEqual([0.5, 0.25]);
    });
});

describe("depth ruler log scale", () => {
    it("pins the limits to the ends of the track", () => {
        expect(depthToPos(DEPTH_MIN_M)).toBe(0);
        expect(depthToPos(DEPTH_MAX_M)).toBeCloseTo(1);
        expect(depthToPos(100)).toBeCloseTo(1);
    });

    it("round-trips through the inverse", () => {
        for (const m of [0.3, 0.75, 1, 2.4, 6]) expect(posToDepth(depthToPos(m))).toBeCloseTo(m, 2);
    });

    it("gives near distances more track than far ones", () => {
        expect(depthToPos(1) - depthToPos(0.5)).toBeGreaterThan(depthToPos(5) - depthToPos(4.5));
    });

    it("steps by a constant ratio and stays inside the limits", () => {
        expect(stepDepth(1, 1)).toBeGreaterThan(1);
        expect(stepDepth(1, -1)).toBeLessThan(1);
        expect(stepDepth(6, 10)).toBe(6);
        expect(stepDepth(0.3, -10)).toBe(0.3);
    });
});

const sample = (p: Partial<CalibrationSample>): CalibrationSample => ({
    blinkLeft: 0.05,
    blinkRight: 0.05,
    smile: 0.1,
    mouthOpen: 0.05,
    browsUp: 0.1,
    shoulderPx: 400,
    ipdPx: 62.34,
    neckRatio: 0.41234,
    faceVisible: true,
    ...p,
});

describe("calibration maths", () => {
    it("puts the threshold 60 % of the way to the acted value", () => {
        expect(threshold(0.1, 0.9)).toBeCloseTo(0.58);
        expect(threshold(0, 0.05)).toBe(0.1);
        expect(threshold(0.9, 1)).toBe(0.95);
    });

    it("detects mirrored eye naming", () => {
        const baseline = sample({});
        expect(detectSwapEyes({ baseline, leftClosed: sample({ blinkLeft: 0.8 }) })).toBe(false);
        expect(detectSwapEyes({ baseline, leftClosed: sample({ blinkRight: 0.8 }) })).toBe(true);
    });

    it("thresholds each eye channel against the prompt that closed it", () => {
        const set = {
            baseline: sample({}),
            leftClosed: sample({ blinkRight: 0.85 }),
            rightClosed: sample({ blinkLeft: 0.75 }),
            smile: sample({ smile: 0.9 }),
            mouthOpen: sample({ mouthOpen: 0.7 }),
            browsUp: sample({ browsUp: 0.6 }),
            posture: sample({}),
        };
        const c = computeCalibration(set, 1.2, 1234.6);
        expect(c.swapEyes).toBe(true);
        expect(c.blinkLeft).toBeCloseTo(0.05 + 0.6 * 0.7);
        expect(c.blinkRight).toBeCloseTo(0.05 + 0.6 * 0.8);
        expect(c.smile).toBeCloseTo(0.58);
        expect(c.shoulderPx).toBe(400);
        expect(c.ipdPx).toBe(62.3);
        expect(c.neckRatio).toBe(0.412);
        expect(c.referenceM).toBe(1.2);
        expect(c.calibratedAt).toBe(1235);
    });
});

describe("safe-zone guardian", () => {
    it("defines the four portrait zones inside the frame", () => {
        for (const z of PORTRAIT_SAFE_ZONES) {
            expect(z.x + z.w).toBeLessThanOrEqual(1);
            expect(z.y + z.h).toBeLessThanOrEqual(1);
        }
    });

    it("measures overlap as a share of the first box", () => {
        expect(overlapShare({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0, w: 1, h: 1 })).toBeCloseTo(0.5);
        expect(overlapShare({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
    });

    it("warns when the face drops into the comments zone", () => {
        expect(guardianZone({ x: 0.3, y: 0.62, w: 0.2, h: 0.12 }, "portrait")).toBe("comments");
        expect(guardianZone({ x: 0.3, y: 0.9, w: 0.2, h: 0.1 }, "portrait")).toBe("bottom");
        expect(guardianZone({ x: 0.4, y: 0.25, w: 0.2, h: 0.15 }, "portrait")).toBeNull();
        expect(guardianZone({ x: 0.3, y: 0.62, w: 0.2, h: 0.12 }, "landscape")).toBeNull();
    });
});

describe("readouts", () => {
    it("advises against the 60-70 IRE face band", () => {
        expect(exposureAdvice(45)).toBe("under");
        expect(exposureAdvice(65)).toBe("good");
        expect(exposureAdvice(80)).toBe("over");
        expect(exposureCorrection(32.5)).toBe(1);
    });

    it("sums only the detector timings", () => {
        expect(visionLatency({ render: 4, scopes: 1, hands: 6, face: 3.5 })).toBe(9.5);
        expect(visionLatency({ "load.pose": 900, "mode.worker": 1, vcamDropped: 50, hands: 6 })).toBe(6);
        expect(visionLatency({ total: 18, pose: 6, hands: 5 })).toBe(18);
    });
});
