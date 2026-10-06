import { studioSchema, visionSchema } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import type { HandSample, SpaceSample } from "../../lib/studio/controller.js";
import {
    acceptMeasuredFov,
    buildHandsCalibration,
    buildSpacePatch,
    cameraFromStudio,
    chooseLens,
    choosePreset,
    combineSamples,
    formatCm,
    formatDeg,
    formatMetres,
    formatMm,
    formatPct,
    gestureThreshold,
    judgeHandSample,
    median,
    parseHeightCm,
    pinchOffFrom,
    pinchOnFrom,
    presetNeedsLens,
    presetVfov,
    summariseHands,
    worldScaleFrom,
} from "./space-calibration-model.js";

const studio = studioSchema.parse({});
const sample = (p: Partial<SpaceSample> & Pick<SpaceSample, "kind">): SpaceSample => ({ frames: 90, issues: [], ...p });

describe("presetVfov", () => {
    it("computes the ZV-E10 FOV from the lens focal length", () => {
        expect(presetVfov("sony-zv-e10", 16, 45)).toBeCloseTo(44.8, 1);
        expect(presetVfov("sony-zv-e10", 50, 45)).toBeLessThan(presetVfov("sony-zv-e10", 16, 45));
    });
    it("uses the fixed webcam FOV and keeps the custom value", () => {
        expect(presetVfov("logitech-c920", 99, 70)).toBe(43.3);
        expect(presetVfov("custom", 16, 61.27)).toBe(61.3);
        expect(presetVfov("custom", 16, 500)).toBe(110);
    });
    it("only the ZV-E10 needs a lens", () => {
        expect(presetNeedsLens("sony-zv-e10")).toBe(true);
        expect(presetNeedsLens("laptop")).toBe(false);
    });
});

describe("camera choice", () => {
    it("switching to a preset resets source and distortion", () => {
        const measured = acceptMeasuredFov(cameraFromStudio(studio), 50, "charuco", 0.1, -0.02);
        expect(measured).toMatchObject({ preset: "custom", vfovDeg: 50, fovSource: "charuco", k1: 0.1 });
        const back = choosePreset(measured, "logitech-brio-90");
        expect(back).toMatchObject({ preset: "logitech-brio-90", vfovDeg: 52, fovSource: "preset", k1: 0, k2: 0 });
    });
    it("lens change clamps and recomputes", () => {
        const c = chooseLens(cameraFromStudio(studio), 3);
        expect(c.lensMm).toBe(8);
        expect(c.vfovDeg).toBeGreaterThan(70);
    });
});

describe("parseHeightCm", () => {
    it("accepts 120-220 with comma decimals", () => {
        expect(parseHeightCm("178")).toBe(178);
        expect(parseHeightCm("172,6")).toBe(173);
    });
    it("rejects out-of-range or empty", () => {
        expect(parseHeightCm("")).toBeNull();
        expect(parseHeightCm("119")).toBeNull();
        expect(parseHeightCm("abc")).toBeNull();
    });
});

describe("worldScaleFrom", () => {
    it("is height / model height clamped to 0.7-1.4", () => {
        expect(worldScaleFrom(1.8, 1.6)).toBe(1.125);
        expect(worldScaleFrom(2.2, 1.0)).toBe(1.4);
        expect(worldScaleFrom(1.0, 2.0)).toBe(0.7);
    });
    it("is undefined when a side is unknown", () => {
        expect(worldScaleFrom(undefined, 1.6)).toBeUndefined();
        expect(worldScaleFrom(1.8, 0)).toBeUndefined();
    });
});

describe("combineSamples", () => {
    it("takes the pose from standing and desk metrics from seated", () => {
        const m = combineSamples(
            sample({ kind: "standing", tiltDeg: 12, heightM: 1.25, distanceM: 1.8, shoulderM: 0.4, modelHeightM: 1.6 }),
            sample({ kind: "seated", distanceM: 0.8, shoulderM: 0.42, irisM: 0.0118, headHeightM: 1.21 }),
        );
        expect(m).toEqual({ tiltDeg: 12, cameraHeightM: 1.25, distanceM: 0.8, shoulderM: 0.42, irisM: 0.0118, seatedHeadM: 1.21, modelHeightM: 1.6 });
    });
    it("ignores samples with no tracked frames", () => {
        expect(combineSamples(sample({ kind: "standing", frames: 0, tiltDeg: 10 }), undefined)).toEqual({});
    });
});

describe("buildSpacePatch", () => {
    const camera = cameraFromStudio(studio);
    it("writes metrics, worldScale and the measured tilt", () => {
        const p = buildSpacePatch({
            studio,
            camera,
            heightM: 1.8,
            measure: { tiltDeg: 14.04, cameraHeightM: 1.234, shoulderM: 0.41, irisM: 0.01175, seatedHeadM: 1.2, modelHeightM: 1.6 },
            useMeasuredTilt: true,
            now: 1000,
        });
        expect(p).toMatchObject({ cameraTiltAuto: false, cameraTiltDeg: 14, cameraHeightM: 1.23, cameraPreset: "sony-zv-e10" });
        expect(p.space).toMatchObject({ heightM: 1.8, shoulderM: 0.41, irisM: 0.0118, seatedHeadM: 1.2, worldScale: 1.125, fovSource: "preset", calibratedAt: 1000 });
        expect(studioSchema.safeParse({ ...studio, ...p }).success).toBe(true);
    });
    it("keeps stored values for skipped steps and leaves the tilt alone when not chosen", () => {
        const prev = { ...studio, space: { ...studio.space, shoulderM: 0.39, worldScale: 1.05 } };
        const p = buildSpacePatch({ studio: prev, camera, heightM: undefined, measure: { tiltDeg: 20 }, useMeasuredTilt: false, now: 5 });
        expect(p.cameraTiltDeg).toBeUndefined();
        expect(p.cameraTiltAuto).toBeUndefined();
        expect(p.space).toMatchObject({ shoulderM: 0.39, worldScale: 1.05, heightM: 0 });
    });
});

describe("formatting", () => {
    it("formats units and unknowns", () => {
        expect(formatCm(0.412)).toBe("41 cm");
        expect(formatMm(0.0117)).toBe("11.7 mm");
        expect(formatDeg(14.04)).toBe("14.0°");
        expect(formatMetres(1.234)).toBe("1.23 m");
        expect(formatDeg(undefined)).toBe("—");
        expect(formatMetres(1.5, "ro")).toBe("1,50 m");
    });
});

const hand = (target: string, p: Partial<HandSample> = {}): HandSample => ({
    target,
    frames: 45,
    handFrames: 45,
    hits: 40,
    confidence: 0.8,
    pinchP10: 0.5,
    pinchP50: 0.7,
    pinchP90: 0.9,
    palmM: 0.085,
    ...p,
});

describe("judgeHandSample", () => {
    it("passes at >= 60 % hits with the hand in frame >= 70 %", () => {
        expect(judgeHandSample(hand("fist", { hits: 27 })).verdict).toBe("pass");
        expect(judgeHandSample(hand("fist", { hits: 26 })).verdict).toBe("miss");
    });
    it("flags a hand that left the frame before judging the shape", () => {
        const j = judgeHandSample(hand("fist", { handFrames: 30, hits: 30 }));
        expect(j.verdict).toBe("outOfFrame");
        expect(j.inFrameRate).toBeCloseTo(30 / 45);
    });
    it("reports no hand and never divides by zero", () => {
        expect(judgeHandSample(hand("fist", { frames: 0, handFrames: 0, hits: 0 }))).toEqual({ verdict: "noHand", hitRate: 0, inFrameRate: 0 });
        expect(judgeHandSample(hand("fist", { handFrames: 0, hits: 0 })).verdict).toBe("noHand");
    });
    it("scores the relaxed hand by presence (no classifier shape)", () => {
        expect(judgeHandSample(hand("relaxed", { hits: 0 })).verdict).toBe("pass");
    });
});

describe("hand thresholds", () => {
    it("median handles even, odd and empty input", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBeUndefined();
    });
    it("clamps the personal gesture threshold to 0.35..0.8", () => {
        expect(gestureThreshold(0.75)).toBeCloseTo(0.6);
        expect(gestureThreshold(0.2)).toBe(0.35);
        expect(gestureThreshold(1)).toBe(0.8);
    });
    it("derives pinch on/off with hysteresis", () => {
        expect(pinchOnFrom(0.16)).toBeCloseTo(0.2);
        expect(pinchOnFrom(0.01)).toBe(0.1);
        expect(pinchOnFrom(0.9)).toBe(0.35);
        expect(pinchOffFrom(0.2, 0.6, 0.38)).toBeCloseTo(0.48);
        expect(pinchOffFrom(0.3, 0.1, 0.38)).toBeCloseTo(0.42);
        expect(pinchOffFrom(0.2, undefined, 0.38)).toBeCloseTo(0.38);
    });
});

describe("summariseHands", () => {
    it("rates the verify pass and keeps unrecorded rows", () => {
        const s = summariseHands({ fist: hand("fist") }, { fist: hand("fist"), pinch: hand("pinch", { hits: 5 }) });
        expect(s.verified).toBe(2);
        expect(s.passRate).toBe(0.5);
        expect(s.rows.find((r) => r.target === "fist")).toMatchObject({ pass: true });
        expect(s.rows.find((r) => r.target === "victory")).toEqual({ target: "victory", pass: false });
    });
});

describe("buildHandsCalibration", () => {
    const prev = visionSchema.parse({}).calibration.hands;
    it("builds a schema-valid patch from recordings + verify", () => {
        const record = {
            relaxed: hand("relaxed", { hits: 0, pinchP10: 0.6, palmM: 0.08 }),
            open_palm: hand("open_palm", { palmM: 0.09 }),
            pinch: hand("pinch", { pinchP90: 0.16, confidence: 0.7 }),
            fist: hand("fist", { confidence: 0.75 }),
        };
        const verify = { fist: hand("fist", { confidence: 0.85, hits: 10 }), open_palm: hand("open_palm", { palmM: 0.1 }) };
        const out = buildHandsCalibration(prev, record, verify, 1234.4);
        expect(out.palmM).toBeCloseTo(0.09);
        expect(out.pinchOn).toBeCloseTo(0.2);
        expect(out.pinchOff).toBeCloseTo(0.48);
        expect(out.gestures.fist).toBeCloseTo(0.64);
        expect(out.gestures.pinch).toBeCloseTo(0.56);
        expect(out.gestures.relaxed).toBeUndefined();
        expect(out.verified.fist).toBeCloseTo(10 / 45, 3);
        expect(out.calibratedAt).toBe(1234);
        expect(visionSchema.parse({ calibration: { hands: out } }).calibration.hands).toEqual(out);
    });
    it("keeps stored pinch values and zero palm when nothing usable was recorded", () => {
        const out = buildHandsCalibration({ ...prev, pinchOn: 0.22, pinchOff: 0.4, gestures: { fist: 0.5 } }, {}, {}, 1);
        expect(out).toMatchObject({ palmM: 0, pinchOn: 0.22, pinchOff: 0.4, gestures: { fist: 0.5 } });
    });
    it("formats pass rates", () => {
        expect(formatPct(0.876)).toBe("88%");
        expect(formatPct(undefined)).toBe("—");
    });
});
