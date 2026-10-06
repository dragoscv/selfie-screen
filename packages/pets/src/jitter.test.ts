import { describe, expect, it } from "vitest";

import { BodyModel } from "./body.js";
import { jitter, lagMs, stepping, type Trace } from "./jitter.js";
import { POSE_INDEX, project, type OutputLandmark, type Pinhole } from "./space.js";

const PIN: Pinhole = { width: 1080, height: 1920, vfovDeg: 45, tiltDeg: 15, heightM: 1.2 };
const FRAME = 1000 / 60;

/** Deterministic Gaussian-ish noise. */
function rng(seed: number): () => number {
    let s = seed;
    const u = () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
    return () => (u() + u() + u() + u() - 2) * 0.866; // ~N(0, 0.5)
}

function landmarks(wristU: number, wristV: number, n: () => number, pxNoise: number, depthNoise: number): OutputLandmark[] {
    const lm: OutputLandmark[] = Array.from({ length: 33 }, () => ({ u: 0.5, v: 0.5, z: 0, visibility: 0 }));
    const j = (u: number, v: number, z = 0): OutputLandmark => ({
        u: u + (n() * pxNoise) / PIN.width,
        v: v + (n() * pxNoise) / PIN.height,
        z: z + n() * depthNoise,
        visibility: 0.95,
    });
    lm[POSE_INDEX.leftShoulder] = j(0.68, 0.55);
    lm[POSE_INDEX.rightShoulder] = j(0.32, 0.55);
    lm[POSE_INDEX.nose] = j(0.5, 0.35);
    // The wrist is near the frame edge and has a noisy MediaPipe z (the old depth-leak case).
    lm[POSE_INDEX.leftWrist] = j(wristU, wristV, -0.1);
    return lm;
}

/**
 * Replays a 60 Hz render against pose results that are captured at ~30 Hz,
 * arrive 30-80 ms later (uneven), with pixel and depth noise like LITE.
 */
function replay(motion: (tMs: number) => number, seconds: number, seed = 3): { trace: Trace; truth: number[] } {
    const n = rng(seed);
    const body = new BodyModel(PIN, 1);
    const pending: { cap: number; arr: number; lm: OutputLandmark[] }[] = [];
    let nextCap = 0;
    const trace: Trace = { t: [], x: [], fresh: [] };
    const truth: number[] = [];
    for (let f = 0; f < seconds * 60; f++) {
        const now = f * FRAME;
        while (nextCap <= now) {
            const latency = 30 + (Math.abs(n()) * 50);
            pending.push({ cap: nextCap, arr: nextCap + latency, lm: landmarks(motion(nextCap), 0.62, n, 3, 0.08) });
            nextCap += 33 + n() * 8;
        }
        let fresh = false;
        while (pending.length && (pending[0]?.arr ?? Infinity) <= now) {
            const m = pending.shift();
            if (m) body.measure({ tMs: m.cap, landmarks: m.lm, distanceM: 1 }, m.arr);
            fresh = true;
        }
        const s = body.sample(now, FRAME / 1000);
        trace.t.push(now);
        trace.x.push(project(PIN, s.joints.leftWrist.p).u * PIN.width);
        trace.fresh.push(fresh);
        truth.push(motion(now) * PIN.width);
    }
    return { trace, truth };
}

const tail = (t: Trace, from: number): Trace => ({ t: t.t.slice(from), x: t.x.slice(from), fresh: t.fresh.slice(from) });

describe("skeleton smoothness (replayed 30 Hz noisy pose, 60 Hz render)", () => {
    it("a still wrist near the frame edge barely moves (depth noise does not leak into x/y)", () => {
        const { trace } = replay(() => 0.85, 6);
        const J = jitter(tail(trace, 120));
        console.warn(`[jitter] still wrist J=${J.toFixed(3)} px/frame²`);
        expect(J).toBeLessThan(0.3);
    });

    it("slow motion has no visible stepping at the pose rate", () => {
        const { trace } = replay((t) => 0.7 + 0.12 * Math.sin((2 * Math.PI * t) / 2000), 8);
        const S = stepping(tail(trace, 120));
        const J = jitter(tail(trace, 120));
        console.warn(`[jitter] 0.5 Hz sine S=${S.toFixed(2)} J=${J.toFixed(3)}`);
        expect(S).toBeLessThan(1.5);
    });

    it("lag on a 1 Hz motion stays within the interpolation delay budget", () => {
        const { trace, truth } = replay((t) => 0.7 + 0.1 * Math.sin((2 * Math.PI * t) / 1000), 8);
        const L = lagMs(trace.x.slice(120), truth.slice(120), FRAME);
        console.warn(`[jitter] 1 Hz lag=${L.toFixed(0)} ms`);
        // Capture->render delay (≈ p90 of latency + interval) plus filter phase lag.
        expect(L).toBeLessThan(260);
    });
});
