import { describe, expect, it } from "vitest";

import type { Pt } from "./geometry.js";
import { classifyHand, HAND } from "./hand.js";
import { makeHand, OPEN, type HandSpec } from "./testing.js";
import { isFrame, isHeart, isPrayer, isTimeout, TwoHandAnalyzer, type HandInput } from "./two-hands.js";

const input = (lm: Pt[], side: "left" | "right" = "left"): HandInput => ({ shape: classifyHand(lm, side), lm });
const hand = (spec: HandSpec, side: "left" | "right" = "left") => input(makeHand(spec), side);

function heartPair(): [HandInput, HandInput] {
    const a = makeHand({ ...OPEN, at: { x: 380, y: 600 } });
    const b = makeHand({ ...OPEN, at: { x: 620, y: 600 } });
    a[HAND.THUMB_TIP] = { x: 495, y: 560 };
    b[HAND.THUMB_TIP] = { x: 505, y: 560 };
    a[HAND.INDEX_TIP] = { x: 495, y: 450 };
    b[HAND.INDEX_TIP] = { x: 505, y: 450 };
    return [input(a), input(b, "right")];
}

describe("two-hand shapes", () => {
    it("detects a finger heart", () => {
        const [a, b] = heartPair();
        expect(isHeart(a, b)).toBe(true);
    });

    it("does not call two open palms side by side a heart", () => {
        expect(isHeart(hand({ ...OPEN, at: { x: 380, y: 600 } }), hand({ ...OPEN, at: { x: 620, y: 600 } }))).toBe(false);
    });

    it("detects the director's frame from two diagonal L shapes", () => {
        const l = { thumb: true, index: true };
        expect(isFrame(hand({ ...l, at: { x: 300, y: 300 } }), hand({ ...l, at: { x: 700, y: 700 }, rotate: 180 }))).toBe(true);
        expect(isFrame(hand({ ...OPEN, at: { x: 300, y: 300 } }), hand({ ...OPEN, at: { x: 700, y: 700 } }))).toBe(false);
    });

    it("detects a timeout T", () => {
        const flat = hand({ ...OPEN, rotate: 90, at: { x: 400, y: 300 } });
        const stem = hand({ ...OPEN, at: { x: 490, y: 490 } });
        expect(isTimeout(flat, stem)).toBe(true);
        expect(isTimeout(stem, flat)).toBe(true);
        expect(isTimeout(hand({ ...OPEN, at: { x: 100, y: 300 } }), stem)).toBe(false);
    });

    it("detects prayer hands", () => {
        expect(isPrayer(hand({ ...OPEN, at: { x: 480, y: 600 } }), hand({ ...OPEN, at: { x: 520, y: 600 } }))).toBe(true);
        expect(isPrayer(hand({ ...OPEN, at: { x: 300, y: 600 } }), hand({ ...OPEN, at: { x: 700, y: 600 } }))).toBe(false);
    });
});

describe("two-hand motion", () => {
    const at = (x: number) => hand({ ...OPEN, at: { x, y: 600 } });

    it("pulses a clap when the hands come together fast", () => {
        const t = new TwoHandAnalyzer();
        const pulses = [
            t.update(at(300), at(700), 0),
            t.update(at(400), at(600), 100),
            t.update(at(470), at(530), 200),
        ].flatMap((r) => r.pulses);
        expect(pulses.map((p) => p.signal)).toEqual(["clap"]);
    });

    it("does not clap when the hands drift together slowly", () => {
        const t = new TwoHandAnalyzer();
        const pulses = [
            t.update(at(300), at(700), 0),
            t.update(at(350), at(650), 500),
            t.update(at(420), at(580), 1000),
            t.update(at(470), at(530), 1500),
        ].flatMap((r) => r.pulses);
        expect(pulses).toEqual([]);
    });

    it("reports spread and squeeze from the distance change rate", () => {
        const spread = new TwoHandAnalyzer();
        const s = [0, 100, 200, 300, 400].map((tm, i) => spread.update(at(450 - i * 25), at(550 + i * 25), tm));
        expect(s.at(-1)?.obs.map((o) => o.signal)).toContain("spread");

        const squeeze = new TwoHandAnalyzer();
        const q = [0, 100, 200, 300, 400].map((tm, i) => squeeze.update(at(350 + i * 25), at(650 - i * 25), tm));
        expect(q.at(-1)?.obs.map((o) => o.signal)).toContain("squeeze");
    });

    it("returns nothing without two hands", () => {
        expect(new TwoHandAnalyzer().update(at(400), null, 0)).toEqual({ obs: [], pulses: [] });
    });
});
