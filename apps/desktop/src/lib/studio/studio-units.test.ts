import { coverFraming } from "@tiksee/pets";
import { describe, expect, it } from "vitest";

import { fadeToward, focalPx, personInFront, pixelHeight, NOMINAL_VFOV_DEG } from "./ar.js";
import { bleCommand, bleRelease, cameraStatus, CameraRemote, type BleCommand } from "./camera-ble.js";
import { effectOrigin, MAX_PARTICLES, ParticleField } from "./effects.js";
import { DigitalFraming, Spring, ZOOM_MAX } from "./framing.js";
import { FALSE_COLOR, bandBounds, falseColorFor, monitorActive } from "./monitor.js";
import { BUFFER_USAGE, MAP_MODE, nv12Length, parseVcamStatus, rgbaToNv12, yuv } from "./output.js";
import { computeScopes, scopeBuffers, scopeSize } from "./scopes.js";

const framingSettings = { zoom: 1, autoReframe: false, deadZone: 0.08, smartWide: true, dof: false, dofStrength: 0.5, afIntervalS: 0 };

describe("NV12 reference (mirrors vcam/shared/src/nv12.rs)", () => {
    it("maps reference colours to BT.709 limited range", () => {
        expect(yuv(0, 0, 0)).toEqual([16, 128, 128]);
        expect(yuv(255, 255, 255)).toEqual([235, 128, 128]);
        expect(yuv(128, 128, 128)).toEqual([126, 128, 128]);
        const [, u, v] = yuv(255, 0, 0);
        expect(v).toBe(240);
        expect(u).toBe(102);
    });

    it("converts a frame with averaged 2x2 chroma and honours a padded stride", () => {
        const w = 4;
        const h = 2;
        const stride = 256;
        const rgba = new Uint8Array(stride * h);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const p = y * stride + x * 4;
                const white = x < 2;
                rgba.set(white ? [255, 255, 255, 255] : [0, 0, 0, 255], p);
            }
        const out = new Uint8Array(nv12Length(w, h));
        rgbaToNv12(rgba, w, h, out, stride);
        expect(Array.from(out.subarray(0, 8))).toEqual([235, 235, 16, 16, 235, 235, 16, 16]);
        expect(Array.from(out.subarray(8))).toEqual([128, 128, 128, 128]);
    });

    it("parses vcam_status leniently", () => {
        expect(parseVcamStatus(null)).toEqual({ state: "off", fps: 0 });
        expect(parseVcamStatus({ state: "streaming", fps: 60, consumer: { width: 1280, height: 720 } })).toEqual({
            state: "streaming",
            fps: 60,
            consumerSize: [1280, 720],
        });
        expect(parseVcamStatus({ state: "weird", consumer: [1920, 1080, 30] }).consumerSize).toEqual([1920, 1080]);
    });

    it("uses the WebGPU spec flag values for buffers and mapping", () => {
        expect(BUFFER_USAGE).toMatchObject({ MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        expect(MAP_MODE.READ).toBe(1);
    });
});

describe("digital framing", () => {
    it("critically damped spring converges without overshoot", () => {
        const s = new Spring(0, 6);
        let max = 0;
        for (let i = 0; i < 300; i++) max = Math.max(max, s.step(1, 1 / 60));
        expect(max).toBeLessThanOrEqual(1 + 1e-9);
        expect(s.value).toBeCloseTo(1, 4);
        // Frame-rate independent: one big step lands where many small ones do.
        const a = new Spring(0, 6);
        const b = new Spring(0, 6);
        a.step(1, 0.5);
        for (let i = 0; i < 30; i++) b.step(1, 0.5 / 30);
        expect(a.value).toBeCloseTo(b.value, 6);
    });

    it("zoom steps by 0.25 and clamps to 1..2.5", () => {
        const d = new DigitalFraming();
        expect(d.stepZoom(1)).toBe(1.25);
        for (let i = 0; i < 10; i++) d.stepZoom(1);
        expect(d.targetZoom).toBe(ZOOM_MAX);
        for (let i = 0; i < 20; i++) d.stepZoom(-1);
        expect(d.targetZoom).toBe(1);
    });

    it("never lets the crop leave the camera image, even chasing a face at the edge", () => {
        const d = new DigitalFraming();
        d.setZoom(2.5);
        const base = coverFraming(1920, 1080, 1080, 1920, false);
        let f = base;
        for (let i = 0; i < 240; i++) {
            f = d.update(base, { ...framingSettings, zoom: 2.5, autoReframe: true, smartWide: false }, { face: { x: 0.99, y: 0.02, w: 0.1, h: 0.15 }, people: 1, standing: false }, 1 / 60);
            expect(f.offsetX).toBeGreaterThanOrEqual(0);
            expect(f.offsetY).toBeGreaterThanOrEqual(0);
            expect(f.offsetX + f.scaleX).toBeLessThanOrEqual(1 + 1e-9);
            expect(f.offsetY + f.scaleY).toBeLessThanOrEqual(1 + 1e-9);
        }
        expect(f.scaleX).toBeCloseTo(base.scaleX / 2.5, 3);
        // It moved toward the face (right edge).
        expect(f.offsetX + f.scaleX).toBeCloseTo(1, 3);
    });

    it("holds still inside the dead zone and widens for two people", () => {
        const d = new DigitalFraming();
        d.setZoom(2);
        const base = coverFraming(1920, 1080, 1080, 1920, false);
        const s = { ...framingSettings, zoom: 2, autoReframe: true };
        for (let i = 0; i < 300; i++) d.update(base, s, { face: { x: 0.5, y: 0.4, w: 0.08, h: 0.15 }, people: 1, standing: false }, 1 / 60);
        const settled = d.framing.offsetX;
        d.update(base, s, { face: { x: 0.505, y: 0.4, w: 0.08, h: 0.15 }, people: 1, standing: false }, 1 / 60);
        expect(d.framing.offsetX).toBeCloseTo(settled, 6);
        for (let i = 0; i < 300; i++) d.update(base, s, { face: { x: 0.5, y: 0.4, w: 0.08, h: 0.15 }, people: 2, standing: false }, 1 / 60);
        expect(d.zoom).toBeCloseTo(1, 3);
    });
});

describe("AR depth", () => {
    it("scales by size * focal / z with a 60° nominal vertical FOV", () => {
        expect(NOMINAL_VFOV_DEG).toBe(60);
        const f = focalPx(1920);
        expect(f).toBeCloseTo(960 / Math.tan(Math.PI / 6), 6);
        expect(pixelHeight(0.3, 1, 1920)).toBeCloseTo(0.3 * f, 6);
        expect(pixelHeight(0.3, 2, 1920)).toBeCloseTo(pixelHeight(0.3, 1, 1920) / 2, 6);
    });

    it("decides occlusion with ±0.1 m hysteresis and keeps it on unknown distance", () => {
        let front = false;
        front = personInFront(front, 1.45, 1.5);
        expect(front).toBe(false); // only 5 cm closer: not yet
        front = personInFront(front, 1.39, 1.5);
        expect(front).toBe(true);
        front = personInFront(front, 1.55, 1.5);
        expect(front).toBe(true); // 5 cm behind: still in front (hysteresis)
        front = personInFront(front, 1.61, 1.5);
        expect(front).toBe(false);
        expect(personInFront(true, undefined, 1.5)).toBe(true);
    });

    it("crossfades the occlusion over 150 ms", () => {
        let v = 0;
        v = fadeToward(v, 1, 75);
        expect(v).toBeCloseTo(0.5);
        v = fadeToward(v, 1, 100);
        expect(v).toBe(1);
        expect(fadeToward(1, 0, 15)).toBeCloseTo(0.9);
    });
});

describe("AR effects", () => {
    const AT: [number, number, number] = [0, 0.1, -0.8];

    it("caps live particles at 400 and expires them", () => {
        const field = new ParticleField(() => 0.5);
        for (let i = 0; i < 20; i++) field.spawn("confetti", AT);
        expect(field.count).toBe(MAX_PARTICLES);
        for (let i = 0; i < 200; i++) field.step(1 / 60);
        expect(field.count).toBe(0);
    });

    it("countdown spawns three numerals, staggered by a second", () => {
        const field = new ParticleField(() => 0.5);
        field.spawn("countdown", AT);
        expect(field.count).toBe(3);
        expect(field.y[0]).toBeGreaterThan(AT[1]); // above the origin (+Y up)
        expect(field.look(0)[0]).toBe(0); // not started yet (first frame)
        field.step(0.2);
        expect(field.look(0)[0]).toBeGreaterThan(0);
        expect(field.look(1)[0]).toBe(0);
    });

    it("an up burst (hearts) rises in world metres", () => {
        const field = new ParticleField(() => 0.5);
        field.spawn("hearts", AT);
        const y0 = field.y[0] ?? 0;
        expect(field.vy[0]).toBeGreaterThan(0);
        for (let i = 0; i < 30; i++) field.step(1 / 60);
        expect(field.y[0]).toBeGreaterThan(y0);
        expect(field.z[0]).toBeCloseTo(AT[2], 6); // Float32Array storage
    });

    it("confetti falls under gravity and stays at metre scale", () => {
        const field = new ParticleField(() => 0.5);
        field.spawn("confetti", AT);
        const vy0 = field.vy[0] ?? 0;
        field.step(0.5);
        expect(field.vy[0]).toBeLessThan(vy0); // -Y velocity grows
        expect(field.vy[0]).toBeCloseTo(vy0 - 0.9 * 0.5, 6);
        for (let i = 0; i < field.count; i++) {
            expect(Math.abs((field.x[i] ?? 0) - AT[0])).toBeLessThan(2);
            expect(Math.abs((field.y[i] ?? 0) - AT[1])).toBeLessThan(2);
            expect(field.size[i]).toBeLessThan(0.1);
        }
    });

    it("effect origin sits 0.2 m in front of the owner, at the top of the face", () => {
        const pin = { width: 1080, height: 1920, vfovDeg: 60 };
        const centre = effectOrigin(pin, { x: 0.4, y: 0.35, w: 0.2, h: 0.2 }, 1.2);
        expect(centre[0]).toBeCloseTo(0, 6);
        expect(centre[1]).toBeCloseTo(unprojectY(pin, 0.35 + 0.2 * 0.15, 1.0), 6);
        expect(centre[2]).toBeCloseTo(-1.0, 6);
        const fallback = effectOrigin(pin, undefined, 0.4);
        expect(fallback[2]).toBeCloseTo(-0.3, 6); // clamped to 0.3 m
        expect(fallback[1]).toBeGreaterThan(0); // v 0.3 = above centre
    });
});

function unprojectY(pin: { height: number; vfovDeg: number }, v: number, d: number): number {
    return (-(v - 0.5) * d * 2 * Math.tan((pin.vfovDeg * Math.PI) / 360));
}

describe("camera BLE mapping", () => {
    it("maps CAMERA_ACTIONS to camera_ble action/value", () => {
        expect(bleCommand("zoomIn")).toEqual({ action: "zoom", value: 1 });
        expect(bleCommand("zoomOut", 3)).toEqual({ action: "zoom", value: -3 });
        expect(bleCommand("focusNear", 2)).toEqual({ action: "focus", value: -2 });
        expect(bleCommand("focusFar")).toEqual({ action: "focus", value: 1 });
        expect(bleCommand("af")).toEqual({ action: "af", value: 0 });
        expect(bleCommand("photo")).toEqual({ action: "photo", value: 0 });
        expect(bleCommand("record")).toEqual({ action: "record", value: 0 });
        expect(bleRelease("zoomIn")).toEqual({ action: "zoom", value: 0 });
        expect(bleRelease("photo")).toBeNull();
    });

    it("a timed hold presses, waits holdMs, then releases", async () => {
        const sent: BleCommand[] = [];
        const remote = new CameraRemote(() => undefined, (c) => {
            sent.push(c);
            return Promise.resolve();
        });
        await remote.run("focusFar", 60);
        expect(sent).toEqual([
            { action: "focus", value: 1 },
            { action: "focus", value: 0 },
        ]);
        sent.length = 0;
        await remote.run("af");
        expect(sent).toEqual([{ action: "af", value: 0 }]);
    });

    it("reads the BLE status payload", () => {
        expect(cameraStatus({ status: "connected", recording: true, focused: false })).toEqual({ connected: true, focused: false, recording: true });
        expect(cameraStatus(null)).toEqual({ connected: false, focused: false, recording: false });
    });
});

describe("monitor + scopes", () => {
    it("false colour bands follow the ARRI-like layout", () => {
        expect(falseColorFor(1)).toEqual([0.5, 0, 0.6]);
        expect(falseColorFor(40)).toEqual([0.1, 0.8, 0.2]);
        expect(falseColorFor(54)).toEqual([1, 0.55, 0.75]);
        expect(falseColorFor(70)).toBeNull();
        expect(falseColorFor(100)).toEqual([1, 0.1, 0.1]);
    });

    it("false colour never puts a non-finite bound into the shader (WGSL has no Infinity)", () => {
        let lo = -Infinity;
        for (const band of FALSE_COLOR) {
            const b = bandBounds(lo, band.below);
            for (const v of [b.lo, b.below]) if (v !== undefined) expect(Number.isFinite(v)).toBe(true);
            lo = band.below;
        }
        expect(bandBounds(97, Infinity)).toEqual({ lo: 97 });
        expect(bandBounds(-Infinity, 2.5)).toEqual({ below: 2.5 });
    });

    it("clean feed disables every aid", () => {
        const m = { peaking: true, peakingColor: "red", peakingThreshold: 0.15, zebra: false, zebraLevel: 95, falseColor: false, clipping: false, guides: "thirds", safeZones: true, scope: "none", afBox: true, horizon: true, loupeZoom: 2, micPanel: false, transcript: false, cleanFeed: false, debug3d: false } as const;
        expect(monitorActive(m)).toBe(true);
        expect(monitorActive({ ...m, cleanFeed: true })).toBe(false);
    });

    it("computes histogram, clipping and face IRE", () => {
        const w = 4;
        const h = 2;
        const rgba = new Uint8Array(w * h * 4);
        // Left half white (clipped), right half black.
        for (let i = 0; i < w * h; i++) rgba.set(i % w < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
        const s = computeScopes(rgba, w, h, w * 4, scopeBuffers(w), { x: 0, y: 0, w: 0.5, h: 1 });
        expect(s.clipHigh).toBeCloseTo(0.5);
        expect(s.clipLow).toBeCloseTo(0.5);
        expect(s.faceIre).toBeCloseTo(100);
        expect(s.histogram?.y[255]).toBe(1);
        expect(s.vectorscope?.data[64 * 128 + 64]).toBe(1);
        expect(scopeSize(1080, 1920)).toEqual([160, 284]);
    });
});
