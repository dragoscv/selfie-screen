import { describe, expect, it } from "vitest";

import { parseVcamStatus } from "./output.js";
import { effectiveFps, nextPumpDeadline } from "./vcam-pacing.js";

/** Simulates rAF ticks at `tick` ms and returns the pump times at `period`. */
function pumps(ticks: number[], period: number): number[] {
    let next = 0;
    const out: number[] = [];
    for (const now of ticks) {
        if (now < next) continue;
        out.push(now);
        next = nextPumpDeadline(next, now, period);
    }
    return out;
}

describe("vcam pacing", () => {
    it("keeps a 30 fps grid on a 60 Hz rAF without drifting", () => {
        const ticks = Array.from({ length: 600 }, (_, i) => i * (1000 / 60));
        const out = pumps(ticks, 1000 / 30);
        // 10 s of 60 Hz ticks -> exactly 300 pumps at 30 fps.
        expect(out).toHaveLength(300);
    });

    it("does not lose frames to jittery rAF ticks", () => {
        // 60 Hz with +-3 ms jitter: the old `now - last < period - 2` gate dropped to ~20-25 fps here.
        const ticks = Array.from({ length: 600 }, (_, i) => i * (1000 / 60) + (i % 2 === 0 ? 3 : -3));
        expect(pumps(ticks, 1000 / 30).length).toBeGreaterThanOrEqual(298);
    });

    it("re-anchors after a stall instead of bursting", () => {
        const period = 1000 / 30;
        // Pumping at 0, then a 500 ms stall: the next deadline is one period before now, not 15 periods ago.
        const next = nextPumpDeadline(period, 500, period);
        expect(next).toBeCloseTo(500 - period);
        // So the tick after the stall pumps once, and the following deadline is back on the grid.
        expect(nextPumpDeadline(next, 500, period)).toBeCloseTo(500);
    });

    it("advances by exactly one period when on time", () => {
        expect(nextPumpDeadline(100, 101, 20)).toBe(120);
    });

    it("caps the pump rate at the consumer fps", () => {
        expect(effectiveFps(60, 30)).toBe(30);
        expect(effectiveFps(30, 60)).toBe(30);
        expect(effectiveFps(60)).toBe(60);
        expect(effectiveFps(60, 0)).toBe(60);
        expect(effectiveFps(0)).toBe(30);
    });

    it("reads the consumer fps from vcam_status (tuple or object)", () => {
        expect(parseVcamStatus({ state: "streaming", consumer: [1080, 1920, 30] }).consumerFps).toBe(30);
        expect(parseVcamStatus({ state: "streaming", consumer: { width: 1080, height: 1920, fps: 60 } }).consumerFps).toBe(60);
        expect(parseVcamStatus({ state: "waiting", consumer: [1080, 1920] }).consumerFps).toBeUndefined();
        expect(parseVcamStatus(null).consumerFps).toBeUndefined();
    });
});
