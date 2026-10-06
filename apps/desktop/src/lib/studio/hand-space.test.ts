import { describe, expect, it } from "vitest";
import { focalFromVfov, type Pinhole } from "@tiksee/pets";

import type { OwnerHand } from "./controller.js";
import { HandSpace, nextPinch, pinchStrength, solveHand } from "./hand-space.js";

const RAW_W = 1920;
const RAW_H = 1080;
const VFOV = 45;

/** A flat synthetic hand (metres, centred) with a given thumb-index gap. */
function worldHand(gapM: number): { x: number; y: number; z: number }[] {
    const pts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 21; i++) {
        const finger = Math.max(0, Math.floor((i - 1) / 4));
        const seg = i === 0 ? 0 : ((i - 1) % 4) + 1;
        pts.push({ x: (finger - 2) * 0.02, y: 0.04 - seg * 0.025, z: (i % 3) * 0.004 });
    }
    // Thumb tip (4) and index tip (8) placed gapM apart around a common point.
    pts[4] = { x: -0.03 - gapM / 2, y: -0.06, z: 0 };
    pts[8] = { x: -0.03 + gapM / 2, y: -0.06, z: 0 };
    return pts;
}

/** Project a world hand at camera translation t (x right, y down, z forward) to raw-normalised coords. */
function ownerHand(t: [number, number, number], gapM: number, pinch: number): OwnerHand {
    const world = worldHand(gapM);
    const f = focalFromVfov(VFOV, RAW_H);
    const raw = world.map((w) => {
        const z = w.z + t[2];
        return { x: (RAW_W / 2 + (f * (w.x + t[0])) / z) / RAW_W, y: (RAW_H / 2 + (f * (w.y + t[1])) / z) / RAW_H, z: 0 };
    });
    return { side: "right", raw, world, score: 0.95, shape: null, shapeConfidence: 0, pinch, inFrame: true, stale: false };
}

const PIN: Pinhole = { width: RAW_W, height: RAW_H, vfovDeg: VFOV, tiltDeg: 0, heightM: 0 };
const identity = (x: number, y: number): [number, number] => [x, y];
const CFG = { cameraVfovDeg: VFOV, palmM: 0, pinchOn: 0.2, pinchOff: 0.38 };

describe("solveHand", () => {
    it("recovers the hand distance from the 21-point solve", () => {
        const h = ownerHand([0.1, 0.05, 0.6], 0.05, 0.6);
        const r = solveHand(h, RAW_W, RAW_H, VFOV, 1);
        expect(r).not.toBeNull();
        expect(r?.cam[0]?.[2]).toBeCloseTo(0.6 + (h.world[0]?.z ?? 0), 2);
        expect(r?.residualPx ?? 99).toBeLessThan(1);
    });

    it("scales depth with the personal palm size", () => {
        const h = ownerHand([0, 0, 0.6], 0.05, 0.6);
        const big = solveHand(h, RAW_W, RAW_H, VFOV, 1.2);
        expect(big?.cam[0]?.[2]).toBeCloseTo(0.72, 1);
    });
});

describe("pinch", () => {
    it("has hysteresis", () => {
        expect(nextPinch(false, 0.25, 0.2, 0.38)).toBe(false);
        expect(nextPinch(false, 0.15, 0.2, 0.38)).toBe(true);
        expect(nextPinch(true, 0.3, 0.2, 0.38)).toBe(true);
        expect(nextPinch(true, 0.4, 0.2, 0.38)).toBe(false);
    });

    it("strength is 1 at touch and 0 past the release ratio", () => {
        expect(pinchStrength(0.05, 0.38)).toBe(1);
        expect(pinchStrength(0.5, 0.38)).toBe(0);
    });
});

describe("HandSpace", () => {
    it("places the hand at the solved depth, pinches, freezes the point at onset, and expires", () => {
        const hs = new HandSpace();
        const open = ownerHand([0, 0, 0.6], 0.08, 0.6);
        let out = hs.update(0, { tMs: 0, hands: [open], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG);
        expect(out[0]?.present).toBe(true);
        expect(out[0]?.source).toBe("solve");
        expect(out[0]?.depthM).toBeGreaterThan(0.55);
        expect(out[0]?.depthM).toBeLessThan(0.65);
        expect(out[0]?.pinching).toBe(false);

        const closed = ownerHand([0, 0, 0.6], 0.005, 0.1);
        out = hs.update(33, { tMs: 33, hands: [closed], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG);
        expect(out[0]?.pinching).toBe(true);
        const p0 = out[0]?.point;
        const moved = ownerHand([0.05, 0, 0.6], 0.005, 0.1);
        out = hs.update(50, { tMs: 50, hands: [moved], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG);
        expect(out[0]?.point).toEqual(p0);

        out = hs.update(500, null, null, PIN, identity, CFG);
        expect(out[0]?.present).toBe(false);
        expect(out[0]?.pinching).toBe(false);
    });

    it("keeps a pinch through a one-result glitch and releases after 200 ms open", () => {
        const hs = new HandSpace();
        const closed = ownerHand([0, 0, 0.6], 0.005, 0.12);
        const open = ownerHand([0, 0, 0.6], 0.08, 1.2);
        let t = 0;
        const step = (h: ReturnType<typeof ownerHand>) => {
            t += 70;
            return hs.update(t, { tMs: t, hands: [h], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG)[0]?.pinching;
        };
        expect(step(closed)).toBe(true);
        step(closed);
        expect(step(open)).toBe(true);
        expect(step(closed)).toBe(true);
        step(open);
        step(open);
        step(open);
        expect(step(open)).toBe(false);
    });

    it("interpolates between results every render frame", () => {
        const hs = new HandSpace();
        const a = ownerHand([0, 0, 0.6], 0.08, 0.6);
        const b = ownerHand([0.1, 0, 0.6], 0.08, 0.6);
        hs.update(0, { tMs: 0, hands: [a], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG);
        const x0 = hs.update(100, { tMs: 100, hands: [b], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG)[0]?.landmarks[0]?.[0] ?? NaN;
        const xMid = hs.update(150, null, null, PIN, identity, CFG)[0]?.landmarks[0]?.[0] ?? NaN;
        const xEnd = hs.update(260, null, null, PIN, identity, CFG)[0]?.landmarks[0]?.[0] ?? NaN;
        expect(xMid).toBeGreaterThan(x0);
        expect(xEnd).toBeGreaterThan(xMid);
    });

    it("ignores stale hands", () => {
        const hs = new HandSpace();
        const h = { ...ownerHand([0, 0, 0.6], 0.08, 0.6), stale: true };
        expect(hs.update(0, { tMs: 0, hands: [h], rawW: RAW_W, rawH: RAW_H }, null, PIN, identity, CFG)).toHaveLength(0);
    });
});
