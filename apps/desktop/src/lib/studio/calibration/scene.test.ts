import { describe, expect, it } from "vitest";

import { gaussian, mulberry32 } from "./linalg.js";
import {
    cameraToRoom,
    findRoomPlanes,
    fitPlane,
    focalToIntrinsics,
    metricPointMap,
    normalizedViewPlaneUv,
    pointMapToRoom,
    ransacPlane,
    recoverFocalShift,
    roomToCamera,
    sceneInputSize,
    vfovFromNormalisedFy,
} from "./scene.js";

const DEG = Math.PI / 180;

describe("MoGe post-processing", () => {
    it("normalizedViewPlaneUv matches MoGe's spans", () => {
        const w = 4;
        const h = 3;
        const uv = normalizedViewPlaneUv(w, h);
        const ar = w / h;
        const sx = ar / Math.sqrt(1 + ar * ar);
        const sy = 1 / Math.sqrt(1 + ar * ar);
        expect(uv[0]).toBeCloseTo((-sx * (w - 1)) / w, 6);
        expect(uv[1]).toBeCloseTo((-sy * (h - 1)) / h, 6);
        const last = 2 * (w * h - 1);
        expect(uv[last]).toBeCloseTo((sx * (w - 1)) / w, 6);
        expect(uv[last + 1]).toBeCloseTo((sy * (h - 1)) / h, 6);
    });

    /**
     * Synthesise MoGe's affine-invariant output: a real scene seen with a known
     * focal, expressed as uv·z/focal (MoGe's x,y convention), then shifted in
     * z by an unknown offset and scaled by an unknown factor.
     */
    function synthMap(w: number, h: number, focal: number, shift: number, scale: number, noise = 0) {
        const uv = normalizedViewPlaneUv(w, h);
        const rand = mulberry32(11);
        const pts = new Float32Array(w * h * 3);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                const u = uv[2 * p]!;
                const v = uv[2 * p + 1]!;
                // A room: back wall at 3 m, floor 1.2 m below, so depth varies.
                const zWall = 3;
                const zFloor = v > 0.05 ? (1.2 * focal) / v : Infinity;
                const z = Math.min(zWall, zFloor) * (1 + noise * gaussian(rand));
                pts[3 * p] = ((u * z) / focal) * scale;
                pts[3 * p + 1] = ((v * z) / focal) * scale;
                pts[3 * p + 2] = (z - shift) * scale;
            }
        return pts;
    }

    it("recovers focal and shift of a synthetic affine point map", () => {
        const w = 96;
        const h = 72;
        const focal = 1.35;
        const shift = 0.8;
        const scale = 0.37;
        const { focal: f, shift: s } = recoverFocalShift(synthMap(w, h, focal, shift, scale), w, h);
        expect(Math.abs(f - focal) / focal).toBeLessThan(0.005);
        expect(s / scale).toBeCloseTo(shift, 2);
    });

    it("tolerates per-pixel depth noise and a mask", () => {
        const w = 96;
        const h = 72;
        const pts = synthMap(w, h, 1.1, 0.5, 1, 0.01);
        const mask = new Float32Array(w * h).fill(1);
        for (let i = 0; i < 300; i++) {
            mask[i] = 0;
            pts[3 * i + 2] = 1e6; // garbage under the mask
        }
        const { focal } = recoverFocalShift(pts, w, h, mask);
        expect(Math.abs(focal - 1.1) / 1.1).toBeLessThan(0.02);
    });

    it("focal -> intrinsics -> vfov matches the pinhole definition", () => {
        const w = 640;
        const h = 480;
        // A camera with vFOV 50°: fy (relative to height) = 0.5 / tan(25°).
        const fy = 0.5 / Math.tan(25 * DEG);
        const diag = Math.hypot(w / h, 1);
        const focal = (2 * fy) / diag;
        const k = focalToIntrinsics(focal, w, h);
        expect(k.fy).toBeCloseTo(fy, 9);
        expect(k.fx * w).toBeCloseTo(k.fy * h, 6); // square pixels
        expect(vfovFromNormalisedFy(k.fy)).toBeCloseTo(50, 9);
    });

    it("metricPointMap returns metric depth and the vFOV", () => {
        const w = 80;
        const h = 60;
        const fy = 0.5 / Math.tan(30 * DEG);
        const focal = (2 * fy) / Math.hypot(w / h, 1);
        const scale = 0.25;
        const map = metricPointMap(synthMap(w, h, focal, 0.6, scale), null, 1 / scale, w, h);
        expect(map.vfovDeg).toBeCloseTo(60, 0);
        expect(map.valid).toBe(w * h);
        // Top-left pixel sees the back wall at 3 m.
        expect(map.xyz[2]).toBeCloseTo(3, 1);
    });

    it("sceneInputSize keeps the aspect ratio with a 512 px long edge", () => {
        expect(sceneInputSize(1920, 1080)).toEqual([512, 288]);
        expect(sceneInputSize(1080, 1920)).toEqual([288, 512]);
    });
});

describe("room frame", () => {
    it("cameraToRoom and roomToCamera are inverse", () => {
        const r = cameraToRoom(0.3, -0.2, 2.1, 17, 1.35);
        const c = roomToCamera(r[0], r[1], r[2], 17, 1.35);
        expect(c[0]).toBeCloseTo(0.3, 9);
        expect(c[1]).toBeCloseTo(-0.2, 9);
        expect(c[2]).toBeCloseTo(2.1, 9);
    });

    it("the optical axis of a camera tilted down goes down", () => {
        const [, y, z] = cameraToRoom(0, 0, 1, 30, 1.5);
        expect(y).toBeCloseTo(1.5 - 0.5, 9);
        expect(z).toBeCloseTo(Math.cos(30 * DEG), 9);
    });
});

describe("planes", () => {
    it("fitPlane recovers a tilted plane", () => {
        const pts: number[] = [];
        for (let i = 0; i < 50; i++) {
            const x = (i % 10) * 0.1;
            const z = Math.floor(i / 10) * 0.1;
            pts.push(x, 0.5 + 0.2 * x - 0.1 * z, z);
        }
        const p = fitPlane(pts, Array.from({ length: 50 }, (_, i) => i))!;
        const n = p.n[1] < 0 ? p.n.map((v) => -v) : p.n;
        const len = Math.hypot(0.2, 1, 0.1);
        expect(n[0]).toBeCloseTo(-0.2 / len, 6);
        expect(n[1]).toBeCloseTo(1 / len, 6);
        expect(n[2]).toBeCloseTo(0.1 / len, 6);
    });

    it("ransacPlane ignores 40 % outliers", () => {
        const rand = mulberry32(2);
        const pts: number[] = [];
        for (let i = 0; i < 600; i++) pts.push(rand() * 2 - 1, 0.75 + 0.003 * gaussian(rand), 1 + rand());
        for (let i = 0; i < 400; i++) pts.push(rand() * 2 - 1, rand() * 2, 1 + rand() * 2);
        const plane = ransacPlane(pts, Array.from({ length: 1000 }, (_, i) => i), { threshold: 0.01, accept: (n) => Math.abs(n[1]) > 0.97 })!;
        expect(Math.abs(plane.d / plane.n[1])).toBeCloseTo(0.75, 2);
        expect(plane.inliers).toBeGreaterThanOrEqual(595);
        expect(plane.inliers).toBeLessThan(640);
    });

    /** Synthesise a camera-space point map of a room with a desk and a back wall, as seen by a tilted camera. */
    function room(tiltDeg: number, camH: number, deskH: number, wallZ: number) {
        const rand = mulberry32(4);
        const camPts: number[] = [];
        const push = (x: number, y: number, z: number) => {
            const c = roomToCamera(x, y + 0.004 * gaussian(rand), z, tiltDeg, camH);
            camPts.push(c[0], c[1], c[2]);
        };
        for (let i = 0; i < 4000; i++) push(rand() * 1.4 - 0.7, deskH, 0.3 + rand() * 0.6); // desk top
        for (let i = 0; i < 6000; i++) push(rand() * 4 - 2, rand() * 2.4, wallZ); // back wall
        for (let i = 0; i < 3000; i++) push(rand() * 4 - 2, 0, 1 + rand() * (wallZ - 1)); // floor
        for (let i = 0; i < 2000; i++) push(rand() * 3 - 1.5, rand() * 2, 0.5 + rand() * 2.5); // clutter
        return camPts;
    }

    it("finds the desk height and wall distance in the room frame", () => {
        const tilt = 12;
        const camH = 1.3;
        const cam = room(tilt, camH, 0.74, 2.6);
        const r = findRoomPlanes(pointMapToRoom(cam, tilt, camH), { cameraHeightM: camH });
        expect(r.deskHeightM).toBeDefined();
        expect(r.wallDistanceM).toBeDefined();
        expect(r.deskHeightM!).toBeCloseTo(0.74, 2);
        expect(r.wallDistanceM!).toBeCloseTo(2.6, 1);
    });

    it("a wrong tilt makes the desk fail the horizontal test rather than report nonsense", () => {
        const cam = room(25, 1.3, 0.74, 2.6);
        const r = findRoomPlanes(pointMapToRoom(cam, 0, 1.3), { cameraHeightM: 1.3 });
        expect(r.deskHeightM === undefined || Math.abs(r.deskHeightM - 0.74) < 0.05).toBe(true);
    });

    it("returns nothing for an empty / invalid map", () => {
        expect(findRoomPlanes(new Float32Array(30).fill(Number.NaN), { cameraHeightM: 1.2 })).toEqual({});
    });
});
