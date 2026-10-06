import { project, type Pinhole } from "@tiksee/pets";
import { describe, expect, it } from "vitest";

import type { Debug3dState } from "../../lib/studio/controller.js";
import {
    CARD_H,
    CARD_W,
    capsuleOutline,
    cardPosition,
    depthHue,
    distanceLine,
    dotRadius,
    floorGrid,
    grabLine,
    HAND_BONES,
    handLabel,
    moodDot,
    needBars,
    petBox,
    pinchFill,
    projectedRadius,
    pushBadge,
    rotateY,
    utilityBars,
    wallGrid,
    worldToShell,
} from "./debug3d-geometry.js";

const PIN: Pinhole = { width: 1080, height: 1920, vfovDeg: 60 };
/** Webcam on top of a monitor: 1.2 m up, pitched 15° down. */
const DESK: Pinhole = { ...PIN, tiltDeg: 15, heightM: 1.2 };
const EPS = 1e-6;

describe("debug3d geometry", () => {
    it("maps a point on the optical axis at 1 m to the frame centre", () => {
        const s = project(PIN, [0, 0, -1]);
        expect(s.u).toBeCloseTo(0.5, 9);
        expect(s.v).toBeCloseTo(0.5, 9);
        expect(s.depthM).toBeCloseTo(1, 9);
        const px = worldToShell(PIN, { left: 10, top: 20, width: 300, height: 400 }, [0, 0, -1]);
        expect(px).toMatchObject({ x: 160, y: 220 });
    });

    it("keeps every floor grid segment inside the frame (with a small margin)", () => {
        const segs = floorGrid(DESK, 0);
        expect(segs.length).toBeGreaterThan(20);
        for (const seg of segs) {
            for (const p of [seg.a, seg.b]) {
                const s = project(DESK, p);
                expect(s.u).toBeGreaterThanOrEqual(-0.05 - EPS);
                expect(s.u).toBeLessThanOrEqual(1.05 + EPS);
                expect(s.v).toBeGreaterThanOrEqual(-0.05 - EPS);
                expect(s.v).toBeLessThanOrEqual(1.05 + EPS);
                expect(s.depthM).toBeGreaterThan(0.1);
            }
        }
    });

    it("stops the floor grid in front of the owner (it never draws through the person)", () => {
        const segs = floorGrid(DESK, 0, 0.3, 4, 0.25, 1.5);
        expect(segs.length).toBeGreaterThan(0);
        for (const seg of segs) for (const p of [seg.a, seg.b]) expect(-p[2]).toBeLessThanOrEqual(1.5 + EPS);
    });

    it("with a level camera at eye height nothing of the floor near the camera is visible", () => {
        // Level camera 1.2 m up, vFOV 60: the floor enters the image only beyond 1.2 / tan(30°) ≈ 2.08 m.
        const segs = floorGrid({ ...PIN, tiltDeg: 0, heightM: 1.2 }, 0);
        // Both ends of every kept segment are visible, so each is beyond ~2.08 m (5 % edge margin).
        for (const seg of segs) expect(Math.min(-seg.a[2], -seg.b[2])).toBeGreaterThan(1.9);
    });

    it("builds a 1 × 2 m wall at the requested depth", () => {
        const segs = wallGrid(0, 0, 1.5);
        // 5 verticals + 9 horizontals at 0.25 m spacing.
        expect(segs).toHaveLength(14);
        for (const seg of segs) expect(seg.a[2]).toBe(-1.5);
    });

    it("ramps depth colour monotonically from near to far", () => {
        let prev = -1;
        for (let d = 0.3; d <= 4; d += 0.1) {
            const h = depthHue(d);
            expect(h).toBeGreaterThanOrEqual(prev);
            prev = h;
        }
        expect(depthHue(0.3)).toBeLessThan(depthHue(4));
        expect(dotRadius(0.5)).toBeGreaterThan(dotRadius(3));
    });

    it("rotates the pet box with yaw and keeps it standing on the contact point", () => {
        const box = petBox([0, 0, -1], Math.PI / 2);
        expect(box).toHaveLength(8);
        for (const c of box.slice(0, 4)) expect(c[1]).toBeCloseTo(0, 9);
        for (const c of box.slice(4)) expect(c[1]).toBeCloseTo(0.2, 9);
        const r = rotateY([0, 0, 1], Math.PI / 2);
        expect(r[0]).toBeCloseTo(1, 9);
        expect(r[2]).toBeCloseTo(0, 9);
    });

    it("outlines a capsule as two end circles joined by two parallel tangent lines", () => {
        const rect = { left: 0, top: 0, width: 1080, height: 1920 };
        const o = capsuleOutline(PIN, rect, { a: [0, 0.2, -1], b: [0, -0.2, -1], r: 0.1, part: "torso" });
        expect(o?.circles).toHaveLength(2);
        expect(o?.sides).toHaveLength(2);
        const r = projectedRadius(PIN, rect, 0.1, 1);
        expect(o?.circles[0]?.r).toBeCloseTo(r, 6);
        // Vertical capsule: side lines are offset horizontally by the radius.
        const [s1, s2] = o?.sides ?? [];
        expect(Math.abs((s1?.[0].x ?? 0) - (s2?.[0].x ?? 0))).toBeCloseTo(2 * r, 6);
        // Head (a == b) is a single circle, no sides; nearer = bigger.
        const head = capsuleOutline(PIN, rect, { a: [0, 0, -0.5], b: [0, 0, -0.5], r: 0.11, part: "head" });
        expect(head?.circles).toHaveLength(1);
        expect(head?.sides).toHaveLength(0);
        expect(projectedRadius(PIN, rect, 0.1, 0.5)).toBeGreaterThan(r);
        expect(capsuleOutline(PIN, rect, { a: [0, 0, 1], b: [0, 0, -1], r: 0.1, part: "neck" })).toBeNull();
    });

    it("normalises utility bars to the best score, keeps the top 5 and flags the decision", () => {
        const ranking = [
            { action: "orbit", score: 0.2 },
            { action: "sleep", score: 0.8 },
            { action: "celebrate", score: 0.4 },
            { action: "perchHead", score: 0.1 },
            { action: "watchOwner", score: 0.6 },
            { action: "visitPet", score: 0.05 },
        ];
        const bars = utilityBars(ranking, "watchOwner");
        expect(bars.map((b) => b.action)).toEqual(["sleep", "watchOwner", "celebrate", "orbit", "perchHead"]);
        expect(bars[0]?.frac).toBe(1);
        expect(bars[1]?.frac).toBeCloseTo(0.75, 9);
        expect(bars.filter((b) => b.chosen).map((b) => b.action)).toEqual(["watchOwner"]);
        expect(utilityBars([{ action: "sleep", score: 0 }], null)[0]?.frac).toBe(0);
        expect(utilityBars([], null)).toEqual([]);
    });

    it("maps needs to clamped bars and mood to the valence/arousal square", () => {
        const bars = needBars({ energy: 1.4, curiosity: 0.5, attention: -0.2, affection: 0.25, play: 0 });
        expect(bars.map((b) => b.label)).toEqual(["E", "C", "A", "Af", "P"]);
        expect(bars.map((b) => b.frac)).toEqual([1, 0.5, 0, 0.25, 0]);
        expect(moodDot({ valence: -1, arousal: 0 }, 10, 20, 40)).toEqual({ x: 10, y: 60 });
        expect(moodDot({ valence: 1, arousal: 1 }, 10, 20, 40)).toEqual({ x: 50, y: 20 });
        expect(moodDot({ valence: 0, arousal: 0.5 }, 10, 20, 40)).toEqual({ x: 30, y: 40 });
        expect(moodDot({ valence: 5, arousal: -3 }, 0, 0, 10)).toEqual({ x: 10, y: 10 });
    });

    it("shows a push badge only above 5 mm", () => {
        expect(pushBadge(0)).toBeNull();
        expect(pushBadge(0.005)).toBeNull();
        expect(pushBadge(0.03)).toBe("PUSH 3 cm");
    });

    it("keeps mind cards inside the frame and stacks off-screen pets in the corner", () => {
        const rect = { left: 0, top: 0, width: 400, height: 700 };
        for (const at of [{ x: 10, y: 10 }, { x: 395, y: 690 }, { x: 200, y: 350 }]) {
            const p = cardPosition(rect, at, 0);
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x + CARD_W).toBeLessThanOrEqual(400);
            expect(p.y + CARD_H).toBeLessThanOrEqual(700);
        }
        const a = cardPosition(rect, null, 0);
        const b = cardPosition(rect, null, 1);
        expect(b.x).toBe(a.x);
        expect(b.y - a.y).toBeGreaterThanOrEqual(CARD_H);
    });

    it("formats the metric distance HUD line with the per-source readings", () => {
        const base = { body: null } as unknown as Debug3dState;
        expect(distanceLine({ ...base, metric: { distanceM: 0.93, relSigma: 0.04, body: 0.95, iris: 0.91 } })).toBe(
            "dist 0.93 m ±4% (body 0.95 / iris 0.91)",
        );
        expect(distanceLine({ ...base, metric: { distanceM: 1.2, relSigma: 0.1 } })).toBe("dist 1.20 m ±10%");
        expect(distanceLine(base)).toBe("dist —");
    });
});

describe("debug3d hands", () => {
    type Hand = NonNullable<Debug3dState["hands"]>[number];
    const hand: Hand = {
        side: "left",
        present: true,
        landmarks: [],
        pinching: false,
        strength: 0.4,
        point: [0, 1, -0.6],
        depthM: 0.62,
        source: "solve",
        shape: "open_palm",
    };

    it("connects all 21 landmarks into one tree (20 fingers bones + palm closure)", () => {
        const used = new Set(HAND_BONES.flat());
        expect(used.size).toBe(21);
        expect(Math.max(...used)).toBe(20);
        expect(HAND_BONES).toHaveLength(21);
    });

    it("labels shape, depth and depth source", () => {
        expect(handLabel(hand)).toBe("L open_palm · 0.62 m · solve");
        expect(handLabel({ ...hand, side: "right", shape: null, source: "wrist" })).toBe("R — · 0.62 m · wrist");
        expect(handLabel({ ...hand, pinching: true })).toBe("L pinch · 0.62 m · solve");
    });

    it("fills the pinch ring with strength and solid while pinching", () => {
        expect(pinchFill(hand)).toBe(0.4);
        expect(pinchFill({ ...hand, strength: 3 })).toBe(1);
        expect(pinchFill({ ...hand, strength: 0.1, pinching: true })).toBe(1);
    });

    it("describes the grab in the HUD", () => {
        const base = { body: null } as unknown as Debug3dState;
        expect(grabLine(base)).toBeNull();
        expect(grabLine({ ...base, grab: { pet: "fox", mode: "resize", scale: 1.234 } })).toBe("grab fox · resize · scale ×1.23");
    });
});
