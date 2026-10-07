import { describe, expect, it } from "vitest";

import { BodyModel, orthoHead } from "./body.js";
import { anchorPoints } from "./roam.js";
import { POSE_INDEX, headAxes, type OutputLandmark, type Pinhole } from "./space.js";

const PIN: Pinhole = { width: 1080, height: 1920, vfovDeg: 60 };

function pose(): OutputLandmark[] {
    const lm: OutputLandmark[] = Array.from({ length: 33 }, () => ({ u: 0.5, v: 0.5, z: 0, visibility: 0 }));
    const set: Partial<Record<keyof typeof POSE_INDEX, [number, number]>> = {
        nose: [0.5, 0.35],
        leftEye: [0.53, 0.33],
        rightEye: [0.47, 0.33],
        leftEar: [0.57, 0.34],
        rightEar: [0.43, 0.34],
        leftShoulder: [0.68, 0.55],
        rightShoulder: [0.32, 0.55],
    };
    for (const [k, [u, v]] of Object.entries(set) as [keyof typeof POSE_INDEX, [number, number]][]) lm[POSE_INDEX[k]] = { u, v, z: 0, visibility: 0.95 };
    return lm;
}

/** Feed `ms` of 30 Hz pose with a 15 Hz face rotation and render at 60 fps; returns per-frame snapshots. */
function run(body: BodyModel, head: (t: number) => { yaw: number; pitch: number; roll: number } | null, ms: number, t0 = 0) {
    const snaps = [];
    for (let t = t0; t < t0 + ms; t += 1000 / 60) {
        const frame = Math.round(t / (1000 / 60));
        if (frame % 2 === 0) {
            const h = frame % 4 === 0 ? head(t) : null;
            body.measure({ tMs: t, landmarks: pose(), distanceM: 1, head: h ? { ...h, tMs: t } : null }, t + 30);
        }
        snaps.push(body.sample(t, 1 / 60));
    }
    return snaps;
}

describe("headAxes", () => {
    it("is identity for a neutral face and follows the display conventions", () => {
        const n = headAxes(0, 0, 0);
        expect(n.forward.map((v) => +v.toFixed(6))).toEqual([0, 0, 1]);
        expect(n.up.map((v) => +v.toFixed(6))).toEqual([0, 1, 0]);
        // Looking up: forward tilts up. Turning to display-right: forward goes +x.
        expect(headAxes(0, 30, 0).forward[1]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
        expect(headAxes(30, 0, 0).forward[0]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
        // Clockwise roll on screen: the top of the head goes to display-right.
        expect(headAxes(0, 0, 20).up[0]).toBeCloseTo(Math.sin(Math.PI / 9), 6);
    });

    it("orthoHead returns an orthonormal basis", () => {
        const o = orthoHead([0.2, -0.1, 0.9], [0.1, 1, 0.3]);
        const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
        expect(dot(o.forward, o.up)).toBeCloseTo(0, 9);
        expect(dot(o.forward, o.right)).toBeCloseTo(0, 9);
        expect(Math.hypot(...o.up)).toBeCloseTo(1, 9);
    });
});

describe("BodyModel head rotation", () => {
    it("bows the head: forward points down, the crown moves towards the camera", () => {
        const body = new BodyModel(PIN, 1);
        const level = run(body, () => ({ yaw: 0, pitch: 0, roll: 0 }), 800).at(-1);
        const bowed = run(body, () => ({ yaw: 0, pitch: -35, roll: 0 }), 800, 800).at(-1);
        expect(level && bowed).toBeTruthy();
        if (!level || !bowed) return;
        expect(bowed.head.rotConf).toBe(1);
        expect(bowed.head.forward[1]).toBeLessThan(-0.45);
        expect(bowed.head.euler.pitch).toBeCloseTo(-35, 0);
        // Bowing forward: crown leans towards the camera (+z) and drops.
        expect(bowed.crown[2]).toBeGreaterThan(level.crown[2] + 0.05);
        expect(bowed.crown[1]).toBeLessThan(level.crown[1]);
    });

    it("leans back: the crown moves away from the camera", () => {
        const body = new BodyModel(PIN, 1);
        const level = run(body, () => ({ yaw: 0, pitch: 0, roll: 0 }), 800).at(-1);
        const back = run(body, () => ({ yaw: 0, pitch: 30, roll: 0 }), 800, 800).at(-1);
        if (!level || !back) throw new Error("no snapshot");
        expect(back.crown[2]).toBeLessThan(level.crown[2] - 0.04);
        expect(back.head.forward[1]).toBeGreaterThan(0.4);
    });

    it("tilts sideways: the crown follows the roll, and the crown anchor rides it", () => {
        const body = new BodyModel(PIN, 1);
        const tilted = run(body, () => ({ yaw: 0, pitch: 0, roll: 25 }), 1000).at(-1);
        if (!tilted) throw new Error("no snapshot");
        expect(tilted.crown[0]).toBeGreaterThan(tilted.head.p[0] + 0.04);
        const a = anchorPoints(tilted, PIN, "left", 0, null);
        expect(a.crown?.[0] ?? 0).toBeGreaterThan(tilted.head.p[0] + 0.04);
    });

    it("moves smoothly through a nod at 60 fps (no per-frame steps from the 15 Hz face rate)", () => {
        const body = new BodyModel(PIN, 1);
        run(body, () => ({ yaw: 0, pitch: 0, roll: 0 }), 600);
        // A 1 Hz nod of ±20°.
        const snaps = run(body, (t) => ({ yaw: 0, pitch: 20 * Math.sin(((t - 600) / 1000) * Math.PI * 2), roll: 0 }), 2000, 600);
        const ys = snaps.slice(30).map((s) => s.head.forward[1]);
        const d = ys.slice(1).map((y, i) => y - (ys[i] ?? y));
        const dd = d.slice(1).map((v, i) => Math.abs(v - (d[i] ?? v)));
        // Second difference = acceleration per frame: a stepped signal spikes, a smooth one stays tiny.
        expect(Math.max(...dd)).toBeLessThan(0.02);
        // It really nods (not filtered flat).
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.4);
    });

    it("fades back to the landmark guess when the face is lost (no snap)", () => {
        const body = new BodyModel(PIN, 1);
        run(body, () => ({ yaw: 0, pitch: -30, roll: 0 }), 800);
        const lost = run(body, () => null, 1500, 800);
        const confs = lost.map((s) => s.head.rotConf);
        for (let i = 1; i < confs.length; i++) expect((confs[i - 1] ?? 0) - (confs[i] ?? 0)).toBeLessThan(0.06);
        expect(confs.at(-1)).toBe(0);
        const fy = lost.map((s) => s.head.forward[1]);
        for (let i = 1; i < fy.length; i++) expect(Math.abs((fy[i] ?? 0) - (fy[i - 1] ?? 0))).toBeLessThan(0.05);
    });
});
