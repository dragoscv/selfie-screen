import { describe, expect, it } from "vitest";

import { Z_MAX, Z_MIN, gizmoDrag, startOf, wrapDeg, type GizmoStart } from "./scene-gizmo-math.js";

const S: GizmoStart = { x: 0.5, y: 0.5, z: 1.5, size: 0.3, yaw: 0, pitch: 0, pitchMax: 90, roll: 0, sizeMin: 0.02, sizeMax: 3, px: 100, py: 100, cx: 100, cy: 100, dist: 50 };
const W = 400;
const H = 800;

describe("in-view gizmo drag", () => {
    it("moves on the screen plane by the pointer delta", () => {
        const r = gizmoDrag({ ...S, mode: "move" }, 140, 180, W, H);
        expect(r.x).toBeCloseTo(0.6, 9);
        expect(r.y).toBeCloseTo(0.6, 9);
        expect(r.z).toBe(1.5);
    });

    it("an axis handle moves only along its axis", () => {
        expect(gizmoDrag({ ...S, mode: "x" }, 140, 180, W, H)).toMatchObject({ x: 0.6, y: 0.5 });
        expect(gizmoDrag({ ...S, mode: "y" }, 140, 180, W, H)).toMatchObject({ x: 0.5, y: 0.6 });
    });

    it("Z changes only depth: up-right = farther, down-left = nearer, clamped", () => {
        const far = gizmoDrag({ ...S, mode: "z" }, 150, 50, W, H);
        expect(far.z).toBeGreaterThan(1.5);
        expect(far.x).toBe(0.5);
        expect(gizmoDrag({ ...S, mode: "z" }, 50, 150, W, H).z).toBeLessThan(1.5);
        expect(gizmoDrag({ ...S, mode: "z" }, 2000, -2000, W, H).z).toBe(Z_MAX);
        expect(gizmoDrag({ ...S, mode: "z" }, -2000, 2000, W, H).z).toBe(Z_MIN);
    });

    it("scale follows the pointer distance from the centre 1:1, within limits", () => {
        expect(gizmoDrag({ ...S, mode: "scale" }, 200, 100, W, H).size).toBeCloseTo(0.6, 9);
        expect(gizmoDrag({ ...S, mode: "scale" }, 5000, 100, W, H).size).toBe(3);
    });

    it("the ring turns yaw (wrapped) or, with Shift on AR objects, roll", () => {
        expect(gizmoDrag({ ...S, mode: "rotate" }, 250, 100, W, H).yaw).toBe(90);
        // The other way too: drag left = negative yaw, and it wraps through -180.
        expect(gizmoDrag({ ...S, mode: "rotate" }, -50, 100, W, H).yaw).toBe(-90);
        expect(gizmoDrag({ ...S, mode: "rotate", yaw: -170 }, 50, 100, W, H).yaw).toBe(160);
        expect(gizmoDrag({ ...S, mode: "rotate", yaw: 170 }, 150, 100, W, H).yaw).toBe(-160);
        const roll = gizmoDrag({ ...S, mode: "rotate" }, 150, 100, W, H, true);
        expect(roll.roll).toBe(30);
        expect(roll.yaw).toBe(0);
    });

    it("dragging the ring up / down tilts (pitch) both ways, within the object's limit", () => {
        expect(gizmoDrag({ ...S, mode: "rotate" }, 100, 150, W, H).pitch).toBe(30);
        expect(gizmoDrag({ ...S, mode: "rotate" }, 100, 50, W, H).pitch).toBe(-30);
        expect(gizmoDrag({ ...S, mode: "rotate", pitchMax: 60 }, 100, 1000, W, H).pitch).toBe(60);
        // Diagonal: both axes at once (orbit feel).
        expect(gizmoDrag({ ...S, mode: "rotate" }, 150, 150, W, H)).toMatchObject({ yaw: 30, pitch: 30 });
    });

    it("the roll handle leans by the pointer's angle around the centre, both ways", () => {
        // Grab to the right of the centre (150,100), sweep up to above it = 90° counter-clockwise.
        const g = { ...S, mode: "roll" as const, px: 150, py: 100 };
        const ccw = gizmoDrag(g, 100, 50, W, H);
        expect(ccw.roll).toBe(90);
        expect(ccw).toMatchObject({ x: 0.5, y: 0.5, yaw: 0, pitch: 0 });
        expect(gizmoDrag(g, 100, 150, W, H).roll).toBe(-90);
        expect(gizmoDrag({ ...g, roll: 170 }, 100, 50, W, H).roll).toBe(-100);
    });

    it("pets keep their pinned roll", () => {
        const s = { arObjects: [], petPins: { cat: { x: 0.4, y: 0.6, z: 1, yaw: 10, pitch: 5, roll: -20 } }, petHands: { scale: {} } };
        expect(startOf(s, { kind: "pet", id: "cat", box: { x: 0, y: 0, w: 0.1, h: 0.1 }, z: 1 })).toMatchObject({ yaw: 10, pitch: 5, roll: -20 });
    });

    it("wrapDeg keeps angles in [-180, 180]", () => {
        expect(wrapDeg(190)).toBe(-170);
        expect(wrapDeg(-190)).toBe(170);
        expect(wrapDeg(540)).toBe(180);
    });
});
