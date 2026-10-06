import { describe, expect, it } from "vitest";

import { MotionAnalyzer } from "./motion.js";

/** Feed a path sampled every `dt` ms; return every pulse signal. */
function run(m: MotionAnalyzer, path: [number, number][], dt = 33, t0 = 0, open = true): string[] {
    return path.flatMap(([x, y], i) => m.update({ x, y }, t0 + i * dt, open).map((p) => p.signal));
}

const line = (from: [number, number], to: [number, number], n: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / (n - 1), from[1] + ((to[1] - from[1]) * i) / (n - 1)]);

describe("swipes", () => {
    it("detects all four directions", () => {
        expect(run(new MotionAnalyzer(), line([0.2, 0.5], [0.6, 0.5], 10))).toEqual(["swipe_right"]);
        expect(run(new MotionAnalyzer(), line([0.7, 0.5], [0.3, 0.5], 10))).toEqual(["swipe_left"]);
        expect(run(new MotionAnalyzer(), line([0.5, 0.8], [0.5, 0.4], 10))).toEqual(["swipe_up"]);
        expect(run(new MotionAnalyzer(), line([0.5, 0.2], [0.5, 0.6], 10))).toEqual(["swipe_down"]);
    });

    it("ignores a slow drift over the same distance", () => {
        expect(run(new MotionAnalyzer(), line([0.2, 0.5], [0.6, 0.5], 40), 50)).toEqual([]);
    });

    it("ignores short movements", () => {
        expect(run(new MotionAnalyzer(), line([0.4, 0.5], [0.55, 0.5], 10))).toEqual([]);
    });

    it("rejects a crooked path (straightness < 0.8)", () => {
        const zigzag: [number, number][] = Array.from({ length: 12 }, (_, i) => [0.2 + i * 0.03, i % 2 ? 0.35 : 0.65]);
        expect(run(new MotionAnalyzer(), zigzag)).toEqual([]);
    });

    it("has an 800 ms refractory period", () => {
        const m = new MotionAnalyzer();
        const first = run(m, line([0.2, 0.5], [0.6, 0.5], 10), 33, 0);
        const back = run(m, line([0.6, 0.5], [0.2, 0.5], 10), 33, 400);
        const later = run(m, line([0.6, 0.5], [0.2, 0.5], 10), 33, 1500);
        expect(first).toEqual(["swipe_right"]);
        expect(back).toEqual([]);
        expect(later).toEqual(["swipe_left"]);
    });

    it("tags pulses with the hand and resets on hand loss", () => {
        const m = new MotionAnalyzer("left");
        const path = line([0.2, 0.5], [0.6, 0.5], 10);
        const pulses = path.slice(0, 5).flatMap(([x, y], i) => m.update({ x, y }, i * 33));
        m.update(null, 170);
        const rest = path.slice(5).flatMap(([x, y], i) => m.update({ x, y }, 200 + i * 33));
        expect(pulses).toEqual([]);
        expect(rest).toEqual([]);
        const again = new MotionAnalyzer("left");
        const out = path.flatMap(([x, y], i) => again.update({ x, y }, i * 33));
        expect(out[0]?.hand).toBe("left");
    });
});

describe("circle and wave", () => {
    it("detects a full circle, either direction", () => {
        const circle = (dir: 1 | -1): [number, number][] =>
            Array.from({ length: 30 }, (_, i) => {
                const a = (dir * i * 2 * Math.PI * 1.05) / 29;
                return [0.5 + 0.08 * Math.cos(a), 0.5 + 0.08 * Math.sin(a)];
            });
        expect(run(new MotionAnalyzer(), circle(1), 40)).toEqual(["circle"]);
        expect(run(new MotionAnalyzer(), circle(-1), 40)).toEqual(["circle"]);
    });

    it("does not call a half circle a circle", () => {
        const half: [number, number][] = Array.from({ length: 20 }, (_, i) => {
            const a = (i * Math.PI) / 19;
            return [0.5 + 0.08 * Math.cos(a), 0.5 + 0.08 * Math.sin(a)];
        });
        expect(run(new MotionAnalyzer(), half, 40)).toEqual([]);
    });

    it("detects a wave from >= 3 side-to-side reversals", () => {
        const wave: [number, number][] = Array.from({ length: 30 }, (_, i) => [0.5 + 0.06 * Math.sin((i / 30) * 2 * Math.PI * 2.5), 0.4]);
        expect(run(new MotionAnalyzer(), wave, 40)).toEqual(["wave"]);
    });

    it("needs an open hand to wave", () => {
        const wave: [number, number][] = Array.from({ length: 30 }, (_, i) => [0.5 + 0.06 * Math.sin((i / 30) * 2 * Math.PI * 2.5), 0.4]);
        expect(run(new MotionAnalyzer(), wave, 40, 0, false)).toEqual([]);
    });

    it("ignores tremor below the amplitude", () => {
        const jitter: [number, number][] = Array.from({ length: 30 }, (_, i) => [0.5 + (i % 2 ? 0.01 : -0.01), 0.4]);
        expect(run(new MotionAnalyzer(), jitter, 40)).toEqual([]);
    });
});
