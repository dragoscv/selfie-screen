import { describe, expect, it } from "vitest";

import { FaceAnalyzer, headPose, poseMatrix, type Blendshapes, type HeadPose } from "./face.js";

const CAL = { blinkLeft: 0.5, blinkRight: 0.5, smile: 0.6, mouthOpen: 0.45, browsUp: 0.55, swapEyes: false };
const FRONT: HeadPose = { yaw: 0, pitch: 0, roll: 0 };

/** Run frames of [durationMs, blendshapes, pose?] at 30 fps; collect pulses and obs signals. */
function play(f: FaceAnalyzer, script: [number, Blendshapes, HeadPose?][]): { pulses: string[]; obs: Set<string> } {
    const pulses: string[] = [];
    const obs = new Set<string>();
    let t = 0;
    for (const [ms, bs, pose] of script) {
        const end = t + ms;
        for (; t < end; t += 33) {
            const r = f.update(bs, pose ?? FRONT, t);
            pulses.push(...r.pulses.map((p) => p.signal));
            for (const o of r.obs) if (o.score >= 0.5) obs.add(o.signal);
        }
    }
    return { pulses, obs };
}

const OPEN_EYES = { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 };
const LEFT_SHUT = { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 };
const BOTH_SHUT = { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 };

describe("head pose", () => {
    it("round-trips yaw/pitch/roll through the 4x4 matrix", () => {
        const p = headPose(poseMatrix({ yaw: 20, pitch: -10, roll: 15 }));
        expect(p.yaw).toBeCloseTo(20, 4);
        expect(p.pitch).toBeCloseTo(-10, 4);
        expect(p.roll).toBeCloseTo(15, 4);
    });

    it("flips yaw and roll when mirrored, keeps pitch", () => {
        const p = headPose(poseMatrix({ yaw: 20, pitch: 10, roll: 15 }), 0, true);
        expect(p.yaw).toBeCloseTo(-20, 4);
        expect(p.pitch).toBeCloseTo(10, 4);
        expect(p.roll).toBeCloseTo(-15, 4);
    });

    it("removes the camera rotation from roll", () => {
        // Camera mounted sideways: the raw image shows the upright head rolled -90.
        const p = headPose(poseMatrix({ yaw: 0, pitch: 0, roll: -90 }), 90);
        expect(p.roll).toBeCloseTo(0, 3);
    });
});

describe("winks and blinks", () => {
    it("fires wink_left for a 250 ms one-eyed closure", () => {
        const r = play(new FaceAnalyzer(CAL), [[200, OPEN_EYES], [250, LEFT_SHUT], [200, OPEN_EYES]]);
        expect(r.pulses).toEqual(["wink_left"]);
    });

    it("mirrors the eye with swapEyes", () => {
        const r = play(new FaceAnalyzer({ ...CAL, swapEyes: true }), [[200, OPEN_EYES], [250, LEFT_SHUT], [200, OPEN_EYES]]);
        expect(r.pulses).toEqual(["wink_right"]);
    });

    it("does not call a normal blink a wink", () => {
        const r = play(new FaceAnalyzer(CAL), [[200, OPEN_EYES], [130, BOTH_SHUT], [200, OPEN_EYES]]);
        expect(r.pulses).toEqual([]);
    });

    it("rejects too-short and too-long one-eyed closures", () => {
        expect(play(new FaceAnalyzer(CAL), [[100, OPEN_EYES], [66, LEFT_SHUT], [200, OPEN_EYES]]).pulses).toEqual([]);
        expect(play(new FaceAnalyzer(CAL), [[100, OPEN_EYES], [900, LEFT_SHUT], [200, OPEN_EYES]]).pulses).toEqual([]);
    });

    it("suppresses winks during a big smile (cheek squint closes one eye)", () => {
        const smiling = { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, cheekSquintLeft: 0.7 };
        const r = play(new FaceAnalyzer(CAL), [[200, { ...OPEN_EYES, ...smiling }], [250, { ...LEFT_SHUT, ...smiling }], [200, { ...OPEN_EYES, ...smiling }]]);
        expect(r.pulses).toEqual([]);
    });

    it("suppresses winks with the head turned away (> 25 deg)", () => {
        const turned = { yaw: 35, pitch: 0, roll: 0 };
        const r = play(new FaceAnalyzer(CAL), [[200, OPEN_EYES, turned], [250, LEFT_SHUT, turned], [200, OPEN_EYES, turned]]);
        expect(r.pulses).toEqual([]);
    });

    it("uses the per-eye calibrated threshold with hysteresis", () => {
        // A droopy left eye rests at 0.55: with the default 0.5 it would be 'closed'; calibrated at 0.75 it is open.
        const droopy = { eyeBlinkLeft: 0.55, eyeBlinkRight: 0.05 };
        const shut = { eyeBlinkLeft: 0.95, eyeBlinkRight: 0.05 };
        const f = new FaceAnalyzer({ ...CAL, blinkLeft: 0.75 });
        const r = play(f, [[200, droopy], [250, shut], [200, droopy]]);
        expect(r.pulses).toEqual(["wink_left"]);
        // Hysteresis: 0.65 is below the threshold but above threshold - 0.15, so a closed eye stays closed.
        const h = new FaceAnalyzer({ ...CAL, blinkLeft: 0.75 });
        h.update(shut, FRONT, 0);
        expect(h.update({ eyeBlinkLeft: 0.65, eyeBlinkRight: 0.05 }, FRONT, 33).leftClosed).toBe(true);
        expect(h.update({ eyeBlinkLeft: 0.55, eyeBlinkRight: 0.05 }, FRONT, 66).leftClosed).toBe(false);
    });

    it("pulses blink_double for two blinks within 700 ms", () => {
        const r = play(new FaceAnalyzer(CAL), [[200, OPEN_EYES], [100, BOTH_SHUT], [200, OPEN_EYES], [100, BOTH_SHUT], [200, OPEN_EYES]]);
        expect(r.pulses).toEqual(["blink_double"]);
    });

    it("does not double-blink when blinks are far apart", () => {
        const r = play(new FaceAnalyzer(CAL), [[200, OPEN_EYES], [100, BOTH_SHUT], [1000, OPEN_EYES], [100, BOTH_SHUT], [200, OPEN_EYES]]);
        expect(r.pulses).toEqual([]);
    });

    it("reports eyes_closed after 600 ms", () => {
        expect(play(new FaceAnalyzer(CAL), [[400, BOTH_SHUT]]).obs.has("eyes_closed")).toBe(false);
        expect(play(new FaceAnalyzer(CAL), [[800, BOTH_SHUT]]).obs.has("eyes_closed")).toBe(true);
    });
});

describe("expressions and head gestures", () => {
    it("scores smile, mouth_open, brows_up, pucker, tongue_out, cheek_puff", () => {
        const r = play(new FaceAnalyzer(CAL), [
            [
                100,
                { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.7, browInnerUp: 0.8, mouthPucker: 0.7, tongueOut: 0.6, cheekPuff: 0.6 },
            ],
        ]);
        for (const s of ["smile", "mouth_open", "brows_up", "pucker", "tongue_out", "cheek_puff"]) expect(r.obs.has(s)).toBe(true);
    });

    it("keeps a neutral face neutral", () => {
        const r = play(new FaceAnalyzer(CAL), [[300, OPEN_EYES]]);
        expect([...r.obs]).toEqual(["eye_contact"]);
    });

    it("detects tilt from roll", () => {
        expect(play(new FaceAnalyzer(CAL), [[100, OPEN_EYES, { yaw: 0, pitch: 0, roll: 20 }]]).obs.has("tilt_right")).toBe(true);
        expect(play(new FaceAnalyzer(CAL), [[100, OPEN_EYES, { yaw: 0, pitch: 0, roll: -20 }]]).obs.has("tilt_left")).toBe(true);
        expect(play(new FaceAnalyzer(CAL), [[100, OPEN_EYES, { yaw: 0, pitch: 0, roll: 10 }]]).obs.has("tilt_right")).toBe(false);
    });

    it("reports look_away only after 1 s past 30 deg", () => {
        const away = { yaw: 40, pitch: 0, roll: 0 };
        expect(play(new FaceAnalyzer(CAL), [[600, OPEN_EYES, away]]).obs.has("look_away")).toBe(false);
        expect(play(new FaceAnalyzer(CAL), [[1200, OPEN_EYES, away]]).obs.has("look_away")).toBe(true);
    });

    it("pulses nod from pitch oscillation and shake from yaw oscillation", () => {
        const osc = (axis: "pitch" | "yaw"): [number, Blendshapes, HeadPose][] =>
            Array.from({ length: 30 }, (_, i) => [33, OPEN_EYES, { yaw: 0, pitch: 0, roll: 0, [axis]: 12 * Math.sin((i / 30) * 2 * Math.PI * 2) }]);
        expect(play(new FaceAnalyzer(CAL), osc("pitch")).pulses).toEqual(["nod"]);
        expect(play(new FaceAnalyzer(CAL), osc("yaw")).pulses).toEqual(["shake"]);
    });
});
