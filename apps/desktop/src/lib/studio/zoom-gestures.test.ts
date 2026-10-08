import { describe, expect, it } from "vitest";

import { DIAL_ZOOM_PER_TURN, IndexDial, type DialHand } from "./index-dial.js";
import { PINCH_ZOOM_GAIN, PINCH_ZOOM_GRACE_MS, PinchZoom, type PinchHand } from "./pinch-zoom.js";
import { OpticalEstimate } from "./optical-estimate.js";
import { ZOOM_RATE_MAX, ZoomDriver, opticalSpeed, type ZoomConfig, type ZoomContext } from "./zoom-driver.js";

const hands = (d: number, pinching = true): PinchHand[] => [
    { present: true, pinching, point: [-d / 2, 0, 0.6] },
    { present: true, pinching, point: [d / 2, 0, 0.6] },
];

function pinchRun(z: PinchZoom, from: number, ms: number, h: PinchHand[], blocked = false) {
    let r = z.update(from, h, blocked);
    for (let t = from + 16; t <= from + ms; t += 16) r = z.update(t, h, blocked);
    return r;
}

describe("two-hand pinch zoom (wish)", () => {
    it("starts only with BOTH hands pinched, never while blocked", () => {
        expect(pinchRun(new PinchZoom(), 0, 300, hands(0.2, false)).active).toBe(false);
        expect(pinchRun(new PinchZoom(), 0, 300, hands(0.2), true).active).toBe(false);
        expect(pinchRun(new PinchZoom(), 0, 300, hands(0.2)).active).toBe(true);
    });

    it("is gentle: doubling the hand distance asks for about x1.5, not more", () => {
        const z = new PinchZoom();
        pinchRun(z, 0, 300, hands(0.2));
        const r = pinchRun(z, 316, 100, hands(0.4));
        expect(Math.exp(r.wish)).toBeGreaterThan(1.4);
        expect(Math.exp(r.wish)).toBeLessThan(1.55);
        expect(PINCH_ZOOM_GAIN).toBeLessThan(1);
    });

    it("hand tremor around the start distance asks for nothing", () => {
        const z = new PinchZoom();
        pinchRun(z, 0, 300, hands(0.2));
        expect(pinchRun(z, 316, 100, hands(0.206)).wish).toBe(0);
    });

    it("tolerates pinch flicker, ends once after the grace time", () => {
        const z = new PinchZoom();
        pinchRun(z, 0, 300, hands(0.2));
        let ended = 0;
        for (let t = 316; t <= 316 + PINCH_ZOOM_GRACE_MS + 50; t += 16) if (z.update(t, hands(0.2, false), false).ended) ended++;
        expect(ended).toBe(1);
    });
});

/** A pointing hand whose index tip is at angle `a` on a circle (output px, y down). */
function dialHand(a: number, shape = "point_up", side: "left" | "right" = "right"): DialHand {
    const lm = Array.from({ length: 21 }, () => ({ x: 500, y: 600 }));
    lm[0] = { x: 500, y: 700 }; // wrist
    lm[9] = { x: 500, y: 640 }; // middle MCP (palm = 60 px)
    lm[8] = { x: 500 + 40 * Math.cos(a), y: 500 + 40 * Math.sin(a) };
    return { side, shape, lm };
}

/** Turn the tip by `turns` (+ = clockwise on screen) over `ms`, 30 Hz hand results. */
function turn(d: IndexDial, from: number, startA: number, turns: number, ms: number, shape = "point_up") {
    let r = d.update(from, [dialHand(startA, shape)], () => false);
    const n = Math.round(ms / 33);
    for (let i = 1; i <= n; i++) r = d.update(from + i * 33, [dialHand(startA + (turns * 2 * Math.PI * i) / n, shape)], () => false);
    return { r, end: from + n * 33, a: startA + turns * 2 * Math.PI };
}

describe("index-finger dial zoom", () => {
    it("clockwise circles zoom in, counter-clockwise zoom out, ~x1.6 per turn", () => {
        const d = new IndexDial();
        const cw = turn(d, 0, 0, 1.5, 1500);
        expect(cw.r.active).toBe(true);
        expect(cw.r.wish).toBeGreaterThan(Math.log(DIAL_ZOOM_PER_TURN));
        const ccw = new IndexDial();
        expect(turn(ccw, 0, 0, -1.5, 1500).r.wish).toBeLessThan(-Math.log(DIAL_ZOOM_PER_TURN));
    });

    it("does not start from a small wiggle or without pointing", () => {
        expect(turn(new IndexDial(), 0, 0, 0.15, 600).r.active).toBe(false);
        expect(turn(new IndexDial(), 0, 0, 1.5, 1500, "open_palm").r.active).toBe(false);
    });

    it("does not start from a hand in a blocked zone", () => {
        const d = new IndexDial();
        let r = d.update(0, [dialHand(0)], () => true);
        for (let i = 1; i <= 45; i++) r = d.update(i * 33, [dialHand((3 * Math.PI * i) / 45)], () => true);
        expect(r.active).toBe(false);
    });

    it("ends when the finger stops pointing", () => {
        const d = new IndexDial();
        const { end } = turn(d, 0, 0, 1.2, 1200);
        let ended = false;
        for (let t = end + 33; t < end + 600; t += 33) if (d.update(t, [dialHand(0, "fist")], () => false).ended) ended = true;
        expect(ended).toBe(true);
        expect(d.active).toBe(false);
    });
});

const CFG: ZoomConfig = { optical: true, opticalMax: 3, digitalMax: 2.5 };
const ctx = (p: Partial<ZoomContext> = {}): ZoomContext => ({ opticalPos: 0, opticalReady: true, digital: 1, ...p });

describe("zoom driver (smooth, optical first)", () => {
    it("caps the speed: a sudden x4 wish is reached gradually, never faster than the cap", () => {
        const z = new ZoomDriver();
        const c = ctx({ opticalReady: false });
        z.begin(c, CFG);
        let digital = 1;
        let prev = 0;
        for (let i = 0; i < 30; i++) {
            const r = z.step(Math.log(4), 1 / 60, { ...c, digital }, CFG);
            if (r.digital !== null) digital = r.digital;
            const l = Math.log(digital);
            expect(l - prev).toBeLessThanOrEqual(ZOOM_RATE_MAX / 60 + 1e-9);
            prev = l;
        }
        expect(digital).toBeLessThan(1.5);
    });

    it("the crop follows smoothly every frame (no steps)", () => {
        const z = new ZoomDriver();
        const c = ctx({ opticalReady: false });
        z.begin(c, CFG);
        let digital = 1;
        const seen: number[] = [];
        for (let i = 0; i < 120; i++) {
            const r = z.step(Math.log(2), 1 / 60, { ...c, digital }, CFG);
            if (r.digital !== null) digital = r.digital;
            seen.push(digital);
        }
        for (let i = 1; i < seen.length; i++) expect(Math.abs((seen[i] ?? 0) - (seen[i - 1] ?? 0))).toBeLessThan(0.03);
        expect(digital).toBeGreaterThan(1.8);
    });

    it("zooms in with the lens first, crops only at the tele end", () => {
        const z = new ZoomDriver();
        z.begin(ctx(), CFG);
        let r = z.step(Math.log(2), 0.1, ctx(), CFG);
        for (let i = 0; i < 5; i++) r = z.step(Math.log(2), 0.1, ctx(), CFG);
        expect(r.optical?.action).toBe("zoomIn");
        expect(r.digital).toBeNull();
        const tele = new ZoomDriver();
        tele.begin(ctx({ opticalPos: 1 }), CFG);
        let t = tele.step(Math.log(1.5), 0.1, ctx({ opticalPos: 1 }), CFG);
        for (let i = 0; i < 5; i++) t = tele.step(Math.log(1.5), 0.1, ctx({ opticalPos: 1 }), CFG);
        expect(t.optical).toBeNull();
        expect(t.digital).toBeGreaterThan(1);
    });

    it("zooms out by removing the crop first, then the lens", () => {
        const z = new ZoomDriver();
        const zoomed = ctx({ opticalPos: 1, digital: 2 });
        z.begin(zoomed, CFG);
        let r = z.step(Math.log(0.6), 0.1, zoomed, CFG);
        for (let i = 0; i < 5; i++) r = z.step(Math.log(0.6), 0.1, zoomed, CFG);
        expect(r.optical).toBeNull();
        expect(r.digital).toBeLessThan(2);
        const lens = new ZoomDriver();
        const atOne = ctx({ opticalPos: 1, digital: 1 });
        lens.begin(atOne, CFG);
        let l = lens.step(Math.log(0.5), 0.1, atOne, CFG);
        for (let i = 0; i < 5; i++) l = lens.step(Math.log(0.5), 0.1, atOne, CFG);
        expect(l.optical?.action).toBe("zoomOut");
    });

    it("never uses the remote's fastest speed", () => {
        expect(opticalSpeed(0.1)).toBe(1);
        expect(opticalSpeed(-2)).toBe(2);
    });
});

describe("optical position estimate", () => {
    it("integrates holds by speed and clamps at both ends", () => {
        const e = new OpticalEstimate();
        e.travelMs = 2000;
        e.hold(1, 2, 0);
        expect(e.position(1000)).toBeCloseTo(0.5, 5);
        e.release(1000);
        expect(e.position(5000)).toBeCloseTo(0.5, 5);
        e.hold(1, 3, 5000);
        expect(e.position(9000)).toBe(1);
        e.release(9000);
        e.hold(-1, 1, 9000);
        expect(e.position(11_000)).toBeCloseTo(1 - 0.45, 5);
        expect(e.position(60_000)).toBe(0);
    });
});
