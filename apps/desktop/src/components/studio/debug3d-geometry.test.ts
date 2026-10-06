import { project, type Pinhole } from "@tiksee/pets";
import { describe, expect, it } from "vitest";

import { depthHue, dotRadius, floorGrid, petBox, rotateY, wallGrid, worldToShell } from "./debug3d-geometry.js";

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
});
