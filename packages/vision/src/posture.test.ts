import { describe, expect, it } from "vitest";

import { neckRatio, PostureAnalyzer, shoulderWidth } from "./posture.js";
import { makePose } from "./testing.js";

const CAL = { shoulderPx: 200, neckRatio: 0.75 };
const signals = (a: PostureAnalyzer, lm: ReturnType<typeof makePose> | null, t = 0) =>
    a.update({ lm, frameH: 1920 }, t).map((o) => o.signal);

describe("posture", () => {
    it("measures shoulder width and neck ratio", () => {
        const p = makePose();
        expect(shoulderWidth(p)).toBe(200);
        expect(neckRatio(p)).toBeCloseTo(0.75);
    });

    it("reports a calibrated upright seated subject as just sitting", () => {
        expect(signals(new PostureAnalyzer(CAL), makePose())).toEqual(["sitting"]);
    });

    it("detects lean in / lean out against the calibrated shoulder width (±25 %)", () => {
        const wide = makePose({ 11: { x: 330, y: 500 }, 12: { x: 670, y: 500 } });
        const narrow = makePose({ 11: { x: 440, y: 500 }, 12: { x: 560, y: 500 } });
        const slight = makePose({ 11: { x: 390, y: 500 }, 12: { x: 610, y: 500 } });
        expect(signals(new PostureAnalyzer(CAL), wide)).toContain("lean_in");
        expect(signals(new PostureAnalyzer(CAL), narrow)).toContain("lean_out");
        expect(signals(new PostureAnalyzer(CAL), slight)).not.toContain("lean_in");
        expect(signals(new PostureAnalyzer({ shoulderPx: 0, neckRatio: 0 }), wide)).not.toContain("lean_in");
    });

    it("flags slouch when the neck ratio drops 15 % below baseline", () => {
        expect(signals(new PostureAnalyzer(CAL), makePose({ 0: { x: 500, y: 400 } }))).toContain("slouch");
        expect(signals(new PostureAnalyzer(CAL), makePose({ 0: { x: 500, y: 365 } }))).not.toContain("slouch");
    });

    it("tells standing from sitting by hips + knees + torso length", () => {
        const standing = makePose({
            11: { x: 450, y: 600 },
            12: { x: 600, y: 600 },
            0: { x: 525, y: 480 },
            23: { x: 470, y: 1000 },
            24: { x: 580, y: 1000 },
            25: { x: 470, y: 1400 },
            26: { x: 580, y: 1400 },
        });
        expect(signals(new PostureAnalyzer(CAL), standing)).toContain("standing");
        expect(signals(new PostureAnalyzer(CAL), makePose())).toContain("sitting");
    });

    it("detects arms crossed", () => {
        const crossed = makePose({ 15: { x: 600, y: 660 }, 16: { x: 400, y: 660 }, 13: { x: 400, y: 650 }, 14: { x: 600, y: 650 } });
        expect(signals(new PostureAnalyzer(CAL), crossed)).toContain("arms_crossed");
    });

    it("detects one hand raised with its side, and both hands on the head", () => {
        const raised = makePose({ 15: { x: 380, y: 150 }, 13: { x: 370, y: 350 } });
        const r = new PostureAnalyzer(CAL).update({ lm: raised, frameH: 1920 }, 0);
        expect(r.find((o) => o.signal === "hand_raised")?.hand).toBe("left");
        const onHead = makePose({ 15: { x: 450, y: 290 }, 16: { x: 550, y: 290 }, 13: { x: 380, y: 400 }, 14: { x: 620, y: 400 } });
        const s = signals(new PostureAnalyzer(CAL), onHead);
        expect(s).toContain("hands_on_head");
        expect(s).not.toContain("hand_raised");
    });

    it("reports away only after 3 s without a person", () => {
        const a = new PostureAnalyzer(CAL);
        expect(signals(a, null, 0)).toEqual([]);
        expect(signals(a, null, 2000)).toEqual([]);
        expect(signals(a, null, 3100)).toEqual(["away"]);
        expect(signals(a, makePose(), 3200)).not.toContain("away");
    });
});
