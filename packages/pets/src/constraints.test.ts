import { describe, expect, it } from "vitest";

import { BodyModel } from "./body.js";
import { PET_GAP_M, Reservations, bodyCapsules, closestOnSegment, resolve, type PetBody } from "./constraints.js";
import { POSE_INDEX, type OutputLandmark, type Pinhole, type Vec3 } from "./space.js";

const PIN: Pinhole = { width: 1080, height: 1920, vfovDeg: 45, tiltDeg: 15, heightM: 1.2 };

function owner() {
    const lm: OutputLandmark[] = Array.from({ length: 33 }, () => ({ u: 0.5, v: 0.5, z: 0, visibility: 0 }));
    const set = (k: keyof typeof POSE_INDEX, u: number, v: number) => (lm[POSE_INDEX[k]] = { u, v, z: 0, visibility: 0.95 });
    set("nose", 0.5, 0.35);
    set("leftEye", 0.53, 0.33);
    set("rightEye", 0.47, 0.33);
    set("leftEar", 0.57, 0.34);
    set("rightEar", 0.43, 0.34);
    set("leftShoulder", 0.7, 0.55);
    set("rightShoulder", 0.3, 0.55);
    set("leftElbow", 0.78, 0.75);
    set("rightElbow", 0.22, 0.75);
    set("leftWrist", 0.75, 0.92);
    set("rightWrist", 0.25, 0.92);
    const body = new BodyModel(PIN, 0.9);
    let snap = body.sample(0, 1 / 60);
    for (let t = 0; t < 1200; t += 16) {
        if (t % 32 === 0) body.measure({ tMs: t, landmarks: lm, distanceM: 0.9 }, t + 40);
        snap = body.sample(t, 1 / 60);
    }
    return snap;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("constraints", () => {
    it("closest point on a segment clamps to its ends", () => {
        expect(closestOnSegment([5, 0, 0], [0, 0, 0], [1, 0, 0])).toEqual([1, 0, 0]);
        expect(closestOnSegment([0.5, 1, 0], [0, 0, 0], [1, 0, 0])).toEqual([0.5, 0, 0]);
    });

    it("builds head, neck, torso and arm capsules from a tracked owner", () => {
        const parts = bodyCapsules(owner()).map((c) => c.part);
        expect(parts).toContain("head");
        expect(parts).toContain("torso");
        expect(parts).toContain("foreArmL");
        expect(bodyCapsules(null)).toEqual([]);
    });

    it("a pet placed inside the owner's head ends up outside it", () => {
        const snap = owner();
        const pet: PetBody = { p: [...snap.head.p] as Vec3, r: 0.08, cy: 0.08, perchedOn: null };
        pet.p[1] -= 0.08; // centre exactly at the head centre
        resolve([pet], bodyCapsules(snap), 3);
        const centre: Vec3 = [pet.p[0], pet.p[1] + pet.cy, pet.p[2]];
        expect(dist(centre, snap.head.p)).toBeGreaterThanOrEqual(0.11 + 0.08 - 1e-6);
    });

    it("a pet perched on the head is not pushed off it", () => {
        const snap = owner();
        const top: Vec3 = [snap.crown[0], snap.crown[1], snap.crown[2]];
        const pet: PetBody = { p: [...top] as Vec3, r: 0.08, cy: 0.08, perchedOn: "head" };
        resolve([pet], bodyCapsules(snap));
        expect(dist(pet.p, top)).toBeLessThan(1e-9);
    });

    it("two pets on the same spot are separated by their radii plus the gap", () => {
        const a: PetBody = { p: [0, 1, -1], r: 0.08, cy: 0.08, perchedOn: null };
        const b: PetBody = { p: [0, 1, -1], r: 0.07, cy: 0.07, perchedOn: null };
        resolve([a, b], [], 3);
        const ca: Vec3 = [a.p[0], a.p[1] + a.cy, a.p[2]];
        const cb: Vec3 = [b.p[0], b.p[1] + b.cy, b.p[2]];
        expect(dist(ca, cb)).toBeGreaterThanOrEqual(0.08 + 0.07 + PET_GAP_M - 1e-3);
    });

    it("a perch is held by one pet at a time and frees on release or timeout", () => {
        const r = new Reservations(1000);
        expect(r.take("shoulderL", "parrot", 0)).toBe(true);
        expect(r.take("shoulderL", "fox", 10)).toBe(false);
        expect(r.take("shoulderL", "parrot", 500)).toBe(true);
        expect(r.take("shoulderL", "fox", 1600)).toBe(true);
        r.release("fox");
        expect(r.holder("shoulderL", 1700)).toBeNull();
    });
});
