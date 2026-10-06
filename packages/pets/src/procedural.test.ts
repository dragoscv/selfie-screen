import { describe, expect, it } from "vitest";

import { seeded } from "./mind.js";
import {
    AngularSpring,
    Breath,
    IdleTwitch,
    SPRING_CLAMP,
    Saccade,
    Squash,
    breathAmplitude,
    breathFrequency,
    inertialTarget,
    minJerk,
    saccadeDuration,
    squashEnvelope,
    squashScale,
    stretchFactor,
} from "./procedural.js";

const DT = 1 / 60;
const DEG = Math.PI / 180;

function runSaccade(seed: number, frames: number, target: (i: number) => [number, number]) {
    const s = new Saccade(seeded(seed));
    const trace: { yaw: number; pitch: number; major: number }[] = [];
    for (let i = 0; i < frames; i++) {
        const [y, p] = target(i);
        const major = s.step(DT, y, p, 0.3);
        trace.push({ yaw: s.yaw, pitch: s.pitch, major });
    }
    return trace;
}

describe("Saccade", () => {
    it("holds the old gaze, then jumps to the new target in 80-120 ms", () => {
        // Settle on 0, then the target moves to 0.4 rad (below the reflex threshold).
        const tr = runSaccade(1, 60 * 6, (i) => (i < 60 * 3 ? [0, 0] : [0.4, 0]));
        const after = tr.slice(60 * 3);
        const firstMove = after.findIndex((f) => f.major > 0);
        // Not instant: the current hold (0.4-2 s) has to run out first...
        expect(firstMove).toBeGreaterThanOrEqual(0);
        expect(firstMove).toBeLessThanOrEqual(120);
        // ...and during the hold the gaze stays within micro-saccade range of 0 (no drift).
        for (const f of after.slice(0, firstMove)) expect(Math.abs(f.yaw)).toBeLessThan(3.5 * DEG);
        // The jump itself lands within 120 ms (8 frames at 60 fps).
        const landed = after.slice(firstMove).findIndex((f) => Math.abs(f.yaw - 0.4) < 3.5 * DEG);
        expect(landed).toBeGreaterThanOrEqual(1);
        expect(landed).toBeLessThanOrEqual(8);
    });

    it("never slides: gaze is piecewise constant with short ballistic jumps", () => {
        // Slowly drifting target (0.3 rad/s): a smooth follower would move every frame.
        const tr = runSaccade(7, 60 * 10, (i) => [Math.sin(i / 200) * 0.6, 0]);
        let still = 0;
        for (let i = 1; i < tr.length; i++) {
            const a = tr[i - 1];
            const b = tr[i];
            if (a && b && Math.abs(b.yaw - a.yaw) < 1e-9 && Math.abs(b.pitch - a.pitch) < 1e-9) still++;
        }
        expect(still / tr.length).toBeGreaterThan(0.6);
    });

    it("micro-saccades stay within 1-3 degrees of the held target", () => {
        const tr = runSaccade(3, 60 * 8, () => [0.2, -0.1]);
        const tail = tr.slice(60 * 3);
        const offsets = tail.map((f) => Math.hypot(f.yaw - 0.2, f.pitch + 0.1));
        expect(Math.max(...offsets)).toBeLessThanOrEqual(3 * DEG + 1e-9);
        // They do happen.
        expect(new Set(tail.map((f) => f.yaw.toFixed(6))).size).toBeGreaterThan(3);
    });

    it("a far target interrupts the hold (reflex) and reports a big shift", () => {
        const tr = runSaccade(5, 60 * 2, (i) => (i < 30 ? [0, 0] : [0.9, 0.2]));
        const j = tr.findIndex((f, i) => i >= 30 && f.major > 0);
        expect(j).toBeGreaterThanOrEqual(30);
        expect(j).toBeLessThanOrEqual(30 + 2);
        expect(tr[j]?.major ?? 0).toBeGreaterThan(20 * DEG);
    });

    it("is deterministic for a seed", () => {
        const t = (i: number): [number, number] => [Math.sin(i / 40) * 0.8, Math.cos(i / 70) * 0.3];
        expect(runSaccade(42, 600, t)).toEqual(runSaccade(42, 600, t));
        expect(runSaccade(42, 600, t)).not.toEqual(runSaccade(43, 600, t));
    });

    it("eases with a minimum-jerk profile and sized durations", () => {
        expect(minJerk(0)).toBe(0);
        expect(minJerk(1)).toBe(1);
        expect(minJerk(0.5)).toBeCloseTo(0.5, 10);
        expect(saccadeDuration(0)).toBeCloseTo(0.08, 10);
        expect(saccadeDuration(2)).toBeCloseTo(0.12, 10);
    });
});

describe("AngularSpring", () => {
    it("settles back to rest when the root stops and never exceeds the clamp", () => {
        const s = new AngularSpring(14, 0.5);
        const out: [number, number, number] = [0, 0, 0];
        let max = 0;
        // 1 s of violent acceleration (well past the clamp), then stop.
        for (let i = 0; i < 60; i++) {
            inertialTarget([0, 0, -1], 40, 0, 0, 6, 0.06, 0.08, out);
            s.step(DT, out[0], out[1], out[2]);
            max = Math.max(max, s.magnitude);
        }
        expect(max).toBeLessThanOrEqual(SPRING_CLAMP + 1e-9);
        expect(max).toBeGreaterThan(SPRING_CLAMP * 0.9);
        for (let i = 0; i < 120; i++) {
            s.step(DT, 0, 0, 0);
            max = Math.max(max, s.magnitude);
        }
        expect(max).toBeLessThanOrEqual(SPRING_CLAMP + 1e-9);
        expect(s.magnitude).toBeLessThan(1e-3);
    });

    it("overshoots once (follow-through) and decays", () => {
        const s = new AngularSpring(9, 0.4);
        s.impulse(0, 0, 2);
        let crossed = false;
        let prev = 0;
        for (let i = 0; i < 180; i++) {
            s.step(DT, 0, 0, 0);
            if (prev > 0 && s.z < 0) crossed = true;
            prev = s.z;
        }
        expect(crossed).toBe(true);
        expect(Math.abs(s.z)).toBeLessThan(1e-3);
    });

    it("tail tip lags opposite to the acceleration", () => {
        const out: [number, number, number] = [0, 0, 0];
        // Bone pointing up, root accelerates +X: rotation about +Z moves the tip toward -X.
        inertialTarget([0, 1, 0], 10, 0, 0, 0, 0.1, 0, out);
        const tipDx = out[1] * 0 - out[2] * 1; // (r × d).x with d = +Y
        expect(tipDx).toBeLessThan(0);
        // Turning left (+yaw) swings the tail to the right (−Y rotation).
        inertialTarget([0, 0, -1], 0, 0, 0, 2, 0, 0.1, out);
        expect(out[1]).toBeLessThan(0);
    });

    it("is stable for long frames (dt spikes)", () => {
        const s = new AngularSpring(18, 0.3);
        s.impulse(5, 0, 0);
        for (let i = 0; i < 20; i++) s.step(0.25, 0, 0, 0);
        expect(Number.isFinite(s.x)).toBe(true);
        expect(s.magnitude).toBeLessThanOrEqual(SPRING_CLAMP + 1e-9);
    });
});

describe("squash & stretch", () => {
    it("preserves volume at every point of the curve and returns to 1", () => {
        for (let u = 0; u <= 1; u += 0.01) {
            const { y, xz } = squashScale(squashEnvelope(u), 0.15);
            expect(xz * y * xz).toBeCloseTo(1, 10);
        }
        const peak = squashScale(1, 0.15);
        expect(peak.y).toBeCloseTo(0.85, 10);
        expect(peak.xz).toBeGreaterThan(1.07);
        expect(peak.xz).toBeLessThan(1.09);
        expect(squashEnvelope(0)).toBe(0);
        expect(squashEnvelope(1)).toBe(0);
    });

    it("Squash runs 120 ms and ends at exactly 1", () => {
        const q = new Squash();
        q.start(0.15, 0.12);
        let minY = 1;
        let frames = 0;
        while (q.active && frames < 100) {
            q.step(DT);
            expect(q.xz * q.y * q.xz).toBeCloseTo(1, 10);
            minY = Math.min(minY, q.y);
            frames++;
        }
        expect(frames).toBeGreaterThanOrEqual(7);
        expect(frames).toBeLessThanOrEqual(8);
        expect(minY).toBeLessThan(0.87);
        expect(q.y).toBe(1);
        expect(q.xz).toBe(1);
    });

    it("stretch caps at 1.08 and is 1 when slow", () => {
        expect(stretchFactor(0)).toBe(1);
        expect(stretchFactor(0.5)).toBe(1);
        expect(stretchFactor(1.4)).toBeCloseTo(1.08, 10);
        expect(stretchFactor(10)).toBeCloseTo(1.08, 10);
    });
});

describe("Breath", () => {
    it("has a 0.25-0.35 Hz period and arousal-scaled amplitude", () => {
        expect(breathFrequency(0)).toBeCloseTo(0.25, 10);
        expect(breathFrequency(1)).toBeCloseTo(0.35, 10);
        expect(breathAmplitude(1)).toBeGreaterThan(breathAmplitude(0));
        for (const arousal of [0, 0.3, 1]) {
            const b = new Breath(0);
            const v: number[] = [];
            for (let i = 0; i < 60 * 20; i++) v.push(b.step(DT, arousal));
            // Period from upward zero crossings.
            const ups: number[] = [];
            for (let i = 1; i < v.length; i++) if ((v[i - 1] ?? 0) < 0 && (v[i] ?? 0) >= 0) ups.push(i);
            const periods = ups.slice(1).map((u, k) => (u - (ups[k] ?? 0)) * DT);
            const mean = periods.reduce((a, p) => a + p, 0) / periods.length;
            expect(mean).toBeCloseTo(1 / breathFrequency(arousal), 1);
            const amp = Math.max(...v.map(Math.abs));
            expect(amp).toBeLessThanOrEqual(breathAmplitude(arousal) * 1.01);
            expect(amp).toBeGreaterThan(breathAmplitude(arousal) * 0.9);
        }
    });
});

describe("IdleTwitch", () => {
    it("fires every 3-8 s, tilts stay small and return to 0, deterministic", () => {
        const run = (seed: number) => {
            const t = new IdleTwitch(seeded(seed), 0);
            const events: number[] = [];
            let maxTilt = 0;
            for (let i = 0; i < 60 * 120; i++) {
                const ev = t.step(i * DT);
                if (ev) events.push(i * DT);
                maxTilt = Math.max(maxTilt, Math.abs(t.tilt));
            }
            return { events, maxTilt, end: t };
        };
        const a = run(9);
        expect(a.events.length).toBeGreaterThan(120 / 8 - 2);
        for (let k = 1; k < a.events.length; k++) {
            const gap = (a.events[k] ?? 0) - (a.events[k - 1] ?? 0);
            expect(gap).toBeGreaterThanOrEqual(3 - DT);
            expect(gap).toBeLessThanOrEqual(8 + DT);
        }
        expect(a.maxTilt).toBeLessThanOrEqual(8 * DEG + 1e-9);
        expect(a.maxTilt).toBeGreaterThan(0);
        expect(run(9).events).toEqual(a.events);
    });
});
