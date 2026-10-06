import { describe, expect, it } from "vitest";

import {
    DistanceFilter,
    cameraPoseFromStanding,
    diagonalToVfov,
    focalFromVfov,
    irisDistance,
    lensVfov,
    solveRootTranslation,
    type CameraIntrinsics,
    type SolveJoint,
} from "./metric.js";
import type { Vec3 } from "./space.js";

const K: CameraIntrinsics = { fPx: focalFromVfov(45, 1080), cx: 960, cy: 540 };

/** A hip-centred metric skeleton (MediaPipe world convention: y down, z away from camera). */
const BODY: Vec3[] = [
    [0, -0.62, -0.05], // nose
    [0.07, -0.6, 0.0], // ears
    [-0.07, -0.6, 0.0],
    [0.19, -0.45, 0.0], // shoulders
    [-0.19, -0.45, 0.0],
    [0.24, -0.2, 0.05], // elbows
    [-0.24, -0.2, 0.05],
    [0.22, 0.02, -0.12], // wrists
    [-0.22, 0.02, -0.12],
    [0.1, 0, 0], // hips
    [-0.1, 0, 0],
];

function projectJoints(t: Vec3, yaw = 0): SolveJoint[] {
    return BODY.map((w) => {
        // Rotate about y (person turning) for the IMAGE, keep the world points as MediaPipe gives them
        // (also rotated: worldLandmarks are in a camera-aligned frame).
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const r: Vec3 = [w[0] * c + w[2] * s, w[1], -w[0] * s + w[2] * c];
        const X = r[0] + t[0];
        const Y = r[1] + t[1];
        const Z = r[2] + t[2];
        return { u: K.cx + (K.fPx * X) / Z, v: K.cy + (K.fPx * Y) / Z, world: r, weight: 1 };
    });
}

describe("intrinsics helpers", () => {
    it("ZV-E10 at 16 mm is ~45° vertical; a C920 (78° diagonal) is ~43°", () => {
        expect(lensVfov(16, 13.2)).toBeCloseTo(44.8, 0);
        expect(diagonalToVfov(78)).toBeCloseTo(43.3, 0);
    });
});

describe("solveRootTranslation", () => {
    it("recovers the body's distance exactly from clean landmarks", () => {
        const r = solveRootTranslation(projectJoints([0.1, 0.2, 1.1]), K);
        expect(r?.t[2]).toBeCloseTo(1.1, 6);
        expect(r?.t[0]).toBeCloseTo(0.1, 6);
        expect(r?.residualPx).toBeLessThan(1e-6);
    });

    it("does not shrink when the person turns 40° (a shoulder pair would read 1.31x too far)", () => {
        const r = solveRootTranslation(projectJoints([0, 0.2, 1.1], (40 * Math.PI) / 180), K);
        expect(r?.t[2]).toBeCloseTo(1.1, 6);
    });

    it("tolerates 2 px landmark noise within ~3 % at 1 m", () => {
        let seed = 11;
        const n = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return (seed / 2147483648 - 0.5) * 4;
        };
        const joints = projectJoints([0, 0.2, 1]).map((j) => ({ ...j, u: j.u + n(), v: j.v + n() }));
        const r = solveRootTranslation(joints, K);
        expect(Math.abs((r?.t[2] ?? 0) - 1)).toBeLessThan(0.03);
    });

    it("needs at least 4 good joints", () => {
        expect(solveRootTranslation(projectJoints([0, 0, 1]).slice(0, 3), K)).toBeNull();
    });
});

describe("iris distance", () => {
    it("11.7 mm iris at 0.6 m in a 45° 1080p frame is ~25 px and maps back to 0.6 m", () => {
        const px = (K.fPx * 0.0117) / 0.6;
        expect(px).toBeGreaterThan(20);
        expect(irisDistance(px, K.fPx)).toBeCloseTo(0.6, 6);
        expect(irisDistance(8, K.fPx)).toBeNull();
    });
});

describe("DistanceFilter", () => {
    it("fuses noisy body and iris readings to within 2 % and rejects a single outlier", () => {
        const f = new DistanceFilter(1);
        let seed = 5;
        const n = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648 - 0.5;
        };
        for (let i = 0; i < 120; i++) {
            const t = i * 33;
            f.update(t, { distanceM: 0.9 * (1 + n() * 0.1), relSigma: 0.05, source: "body" });
            if (i % 2) f.update(t, { distanceM: 0.9 * (1 + n() * 0.08), relSigma: 0.045, source: "iris" });
        }
        expect(Math.abs(f.distanceM - 0.9) / 0.9).toBeLessThan(0.02);
        expect(f.update(4000, { distanceM: 2.5, relSigma: 0.05, source: "body" })).toBe(false);
        expect(Math.abs(f.distanceM - 0.9) / 0.9).toBeLessThan(0.03);
    });

    it("follows a real move (stands up and steps back) within ~1 s", () => {
        const f = new DistanceFilter(0.9);
        for (let i = 0; i < 30; i++) f.update(i * 33, { distanceM: 0.9, relSigma: 0.05, source: "body" });
        for (let i = 30; i < 70; i++) f.update(i * 33, { distanceM: 1.6, relSigma: 0.05, source: "body" });
        expect(f.distanceM).toBeGreaterThan(1.5);
    });
});

describe("cameraPoseFromStanding", () => {
    /** Room -> camera frame (y down, z forward) for a camera at height h pitched down by t. */
    function roomToCam(p: Vec3, h: number, tDeg: number): Vec3 {
        const t = (tDeg * Math.PI) / 180;
        // Room: y up, z towards the scene (forward). Camera rotated down by t about x.
        const y = p[1] - h;
        const z = p[2];
        // Camera forward = (0, -sin t, cos t), camera down = (0, -cos t, -sin t) in room (y up).
        return [p[0], -(y * Math.cos(t)) - z * Math.sin(t), -y * Math.sin(t) + z * Math.cos(t)];
    }

    it("recovers a monitor-top webcam (1.25 m up, 18° down) from a 1.80 m person standing 1.5 m away", () => {
        const h = 1.25;
        const tilt = 18;
        const hip = roomToCam([0, 0.95, 1.5], h, tilt);
        const shoulder = roomToCam([0, 1.45, 1.5], h, tilt);
        const top = roomToCam([0, 1.8, 1.5], h, tilt);
        const r = cameraPoseFromStanding(hip, shoulder, top, 1.8);
        expect(r?.tiltDeg).toBeCloseTo(tilt, 6);
        expect(r?.heightM).toBeCloseTo(h, 6);
    });
});
