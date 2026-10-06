import { describe, expect, it } from "vitest";

import { BodyModel, FADE_MS, LOST_AFTER_MS } from "./body.js";
import { PetRoamer, anchorPoints, onScreen } from "./roam.js";
import { POSE_INDEX, camToWorld, depthOf, focalPx, pixelsAt, project, tiltFromUpright, unproject, worldToCam, type OutputLandmark, type Pinhole } from "./space.js";

const PIN: Pinhole = { width: 1080, height: 1920, vfovDeg: 60 };

function pose(over: Partial<Record<keyof typeof POSE_INDEX, [number, number]>> = {}, vis = 0.95): OutputLandmark[] {
    const lm: OutputLandmark[] = Array.from({ length: 33 }, () => ({ u: 0.5, v: 0.5, z: 0, visibility: 0 }));
    const set: Partial<Record<keyof typeof POSE_INDEX, [number, number]>> = {
        nose: [0.5, 0.35],
        leftEye: [0.53, 0.33],
        rightEye: [0.47, 0.33],
        leftEar: [0.57, 0.34],
        rightEar: [0.43, 0.34],
        leftShoulder: [0.68, 0.55],
        rightShoulder: [0.32, 0.55],
        ...over,
    };
    for (const [k, [u, v]] of Object.entries(set) as [keyof typeof POSE_INDEX, [number, number]][]) {
        lm[POSE_INDEX[k]] = { u, v, z: 0, visibility: vis };
    }
    return lm;
}

describe("pinhole", () => {
    it("unproject and project are inverses and the centre is on the optical axis", () => {
        const p = unproject(PIN, 0.5, 0.5, 1.2);
        expect(p[0]).toBeCloseTo(0, 9);
        expect(p[1]).toBeCloseTo(0, 9);
        expect(p[2]).toBeCloseTo(-1.2, 9);
        const q = unproject(PIN, 0.2, 0.8, 0.9);
        const s = project(PIN, q);
        expect(s.u).toBeCloseTo(0.2, 9);
        expect(s.v).toBeCloseTo(0.8, 9);
        expect(s.depthM).toBeCloseTo(0.9, 9);
    });

    it("v is down on screen and +Y is up in the world", () => {
        expect(unproject(PIN, 0.5, 0.1, 1)[1]).toBeGreaterThan(0);
        expect(unproject(PIN, 0.9, 0.5, 1)[0]).toBeGreaterThan(0);
    });

    it("pixel size halves when the distance doubles", () => {
        expect(focalPx(PIN)).toBeCloseTo(1920 / 2 / Math.tan(Math.PI / 6), 6);
        expect(pixelsAt(PIN, 0.2, 2)).toBeCloseTo(pixelsAt(PIN, 0.2, 1) / 2, 6);
    });

    it("a camera on a monitor (1.2 m, 15° down) maps the image centre down to the floor ahead", () => {
        const desk: Pinhole = { ...PIN, tiltDeg: 15, heightM: 1.2 };
        const c = unproject(desk, 0.5, 0.5, 1);
        // 1 m along an axis pitched 15° down: 0.26 m lower, 0.97 m ahead.
        expect(c[1]).toBeCloseTo(1.2 - Math.sin(Math.PI / 12), 6);
        expect(c[2]).toBeCloseTo(-Math.cos(Math.PI / 12), 6);
        expect(depthOf(desk, c)).toBeCloseTo(1, 9);
        const back = project(desk, c);
        expect(back.u).toBeCloseTo(0.5, 9);
        expect(back.v).toBeCloseTo(0.5, 9);
        const w: [number, number, number] = [0.3, 0.4, -1.7];
        const rt = camToWorld(desk, worldToCam(desk, w));
        rt.forEach((v, i) => expect(v).toBeCloseTo(w[i] ?? 0, 9));
    });

    it("reads the camera tilt from an upright neck", () => {
        const t = (15 * Math.PI) / 180;
        // Room-vertical 0.2 m segment seen by a camera pitched down 15°.
        const bottom: [number, number, number] = [0, 0, -1];
        const top: [number, number, number] = [0, 0.2 * Math.cos(t), -1 + 0.2 * Math.sin(t)];
        expect(tiltFromUpright(bottom, top)).toBeCloseTo(15, 6);
        expect(tiltFromUpright(bottom, [0, 0.01, -1])).toBeNull();
    });
});

describe("BodyModel", () => {
    it("keeps a still body still under landmark noise (One-Euro on measurements)", () => {
        const body = new BodyModel(PIN, 1);
        let seed = 7;
        const noise = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return (seed / 2147483648 - 0.5) * 0.006; // ±3 px at 1080 wide
        };
        const xs: number[] = [];
        for (let frame = 0; frame < 240; frame++) {
            const t = frame * (1000 / 60);
            if (frame % 4 === 0) body.measure({ tMs: t, landmarks: pose({ leftShoulder: [0.68 + noise(), 0.55 + noise()] }), distanceM: 1 + noise() * 10 });
            xs.push(body.sample(t, 1 / 60).joints.leftShoulder.p[0]);
        }
        const tail = xs.slice(120);
        const range = Math.max(...tail) - Math.min(...tail);
        // Raw noise is ±3 px ≈ ±2 mm at 1 m; filtered wobble stays under 2 mm peak-to-peak.
        expect(range).toBeLessThan(0.002);
    });

    it("moves continuously between 10 Hz pose updates at a 60 fps render (no steps)", () => {
        const body = new BodyModel(PIN, 1);
        const xs: number[] = [];
        for (let frame = 0; frame < 120; frame++) {
            const t = frame * (1000 / 60);
            if (frame % 6 === 0) {
                const u = 0.68 + (frame / 120) * 0.1; // the shoulder slides right steadily
                body.measure({ tMs: t, landmarks: pose({ leftShoulder: [u, 0.55] }), distanceM: 1 });
            }
            xs.push(body.sample(t, 1 / 60).joints.leftShoulder.p[0]);
        }
        // After warm-up, per-frame increments stay small and never jump at the 10 Hz boundaries.
        const steps = xs.slice(30).map((x, i, a) => (i ? x - (a[i - 1] ?? x) : 0)).slice(1);
        const max = Math.max(...steps.map(Math.abs));
        const mean = steps.reduce((s, v) => s + Math.abs(v), 0) / steps.length;
        expect(max).toBeLessThan(mean * 3);
    });

    it("keeps the last position through a dropout and fades confidence instead of popping", () => {
        const body = new BodyModel(PIN, 1);
        body.measure({ tMs: 0, landmarks: pose(), distanceM: 1 });
        let snap = body.sample(0, 1 / 60);
        // Fade-in takes FADE_MS / 2.
        for (let t = 16; t < FADE_MS; t += 16) snap = body.sample(t, 1 / 60);
        expect(snap.joints.leftShoulder.conf).toBe(1);
        const p0 = snap.joints.leftShoulder.p;
        // Last sighting at t=0; nobody seen afterwards. Still fully on before LOST_AFTER_MS,
        // then fading linearly, never a jump to 0.
        body.measure({ tMs: FADE_MS, landmarks: null, distanceM: undefined });
        snap = body.sample(LOST_AFTER_MS - 16, 1 / 60);
        expect(snap.joints.leftShoulder.conf).toBe(1);
        let prev = 1;
        for (let t = LOST_AFTER_MS; t < LOST_AFTER_MS + FADE_MS + 200; t += 16) {
            snap = body.sample(t, 1 / 60);
            const c = snap.joints.leftShoulder.conf;
            expect(prev - c).toBeLessThan(0.06);
            prev = c;
        }
        expect(prev).toBe(0);
        expect(snap.joints.leftShoulder.p).toEqual(p0);
    });

    it("places the head above the shoulders and the shoulders at the measured distance", () => {
        const body = new BodyModel(PIN, 1.4);
        body.measure({ tMs: 0, landmarks: pose(), distanceM: 1.4 });
        let snap = body.sample(0, 0.016);
        for (let t = 16; t < 400; t += 16) snap = body.sample(t, 0.016);
        expect(snap.head.p[1]).toBeGreaterThan(snap.joints.leftShoulder.p[1]);
        expect(-snap.joints.leftShoulder.p[2]).toBeCloseTo(1.4, 1);
        expect(snap.crown[1]).toBeGreaterThan(snap.head.p[1]);
    });
});

describe("PetRoamer", () => {
    function settledBody(distance = 1) {
        const body = new BodyModel(PIN, distance);
        body.measure({ tMs: 0, landmarks: pose(), distanceM: distance });
        let snap = body.sample(0, 0.016);
        for (let t = 16; t < 400; t += 16) snap = body.sample(t, 0.016);
        return snap;
    }

    it("perches on its own shoulder (image-left pet on the image-left shoulder)", () => {
        const snap = settledBody();
        const left = new PetRoamer({ side: "left", family: "bird", heightM: 0.2, rand: () => 0.9 });
        let p = left.update(snap, PIN, 0, 0.016);
        for (let t = 16; t < 3000; t += 16) p = left.update(snap, PIN, t, 0.016);
        expect(p.anchor).toBe("shoulderL");
        expect(p.settled).toBe(true);
        expect(project(PIN, p.p).u).toBeLessThan(0.5);
    });

    it("never leaves the frame when nobody is tracked: goes to a ledge on screen", () => {
        const r = new PetRoamer({ side: "right", family: "quadruped", heightM: 0.2, rand: () => 0.9 });
        let p = r.update(null, PIN, 0, 0.016);
        for (let t = 16; t < 4000; t += 16) p = r.update(null, PIN, t, 0.016);
        expect(p.anchor).toBe("ledgeR");
        expect(onScreen(PIN, p.p, 0)).toBe(true);
    });

    it("walkers hop between perches instead of sliding through the air", () => {
        const snap = settledBody();
        const r = new PetRoamer({ side: "left", family: "quadruped", heightM: 0.2, rand: () => 0.9 });
        let sawHop = false;
        let p = r.update(null, PIN, 0, 0.016);
        for (let t = 16; t < 2000; t += 16) p = r.update(null, PIN, t, 0.016);
        for (let t = 2000; t < 5000; t += 16) {
            p = r.update(snap, PIN, t, 0.016);
            if (p.gait === "hop") sawHop = true;
        }
        expect(sawHop).toBe(true);
        expect(p.anchor).toBe("shoulderL");
    });

    it("moves at bounded speed (no teleports) when the anchor changes", () => {
        const snap = settledBody();
        const r = new PetRoamer({ side: "left", family: "bird", heightM: 0.2, rand: () => 0.9 });
        let p = r.update(snap, PIN, 0, 0.016);
        for (let t = 16; t < 2000; t += 16) p = r.update(snap, PIN, t, 0.016);
        r.request("crown");
        let prev = p.p;
        for (let t = 2000; t < 5000; t += 16) {
            p = r.update(snap, PIN, t, 0.016);
            const d = Math.hypot(p.p[0] - prev[0], p.p[1] - prev[1], p.p[2] - prev[2]);
            expect(d).toBeLessThan(1.5 * 0.016 + 0.01);
            prev = p.p;
        }
        expect(p.anchor).toBe("crown");
    });

    it("offers an orbit around the head that passes behind the owner", () => {
        const snap = settledBody();
        let behind = false;
        for (let t = 0; t < 7000; t += 100) {
            const a = anchorPoints(snap, PIN, "left", t / 1000, null);
            if (a.orbit && -a.orbit[2] > snap.distanceM + 0.1) behind = true;
        }
        expect(behind).toBe(true);
    });
});
