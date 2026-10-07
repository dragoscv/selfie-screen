import { describe, expect, it } from "vitest";

import { OpticalEstimate, PINCH_ZOOM_GRACE_MS, PinchZoom, opticalSpeed, type PinchHand, type PinchZoomConfig, type PinchZoomContext } from "./pinch-zoom.js";

const CFG: PinchZoomConfig = { optical: true, opticalMax: 3, digitalMax: 2.5, gain: 1.5 };
const hands = (d: number, pinching = true): PinchHand[] => [
    { present: true, pinching, point: [-d / 2, 0, 0.6] },
    { present: true, pinching, point: [d / 2, 0, 0.6] },
];
const ctx = (p: Partial<PinchZoomContext> = {}): PinchZoomContext => ({ opticalPos: 0, opticalReady: true, digital: 1, blocked: false, ...p });

/** Run the controller for `ms` at 60 fps with fixed hands; returns the last result. */
function run(z: PinchZoom, from: number, ms: number, h: PinchHand[], c: PinchZoomContext, cfg = CFG) {
    let r = z.update(from, h, c, cfg);
    for (let t = from + 16; t <= from + ms; t += 16) r = z.update(t, h, c, cfg);
    return r;
}

describe("two-hand pinch zoom", () => {
    it("starts only with BOTH hands pinched (one pinch or open hands do nothing)", () => {
        const z = new PinchZoom();
        expect(run(z, 0, 300, hands(0.2, false), ctx()).active).toBe(false);
        expect(run(z, 400, 300, [hands(0.2)[0]!, { ...hands(0.2)[1]!, pinching: false }], ctx()).active).toBe(false);
        expect(run(z, 800, 300, hands(0.2), ctx()).active).toBe(true);
    });

    it("never starts while a pet is held", () => {
        expect(run(new PinchZoom(), 0, 300, hands(0.2), ctx({ blocked: true })).active).toBe(false);
    });

    it("pulling apart drives the OPTICAL zoom first, faster the further apart", () => {
        const z = new PinchZoom();
        run(z, 0, 200, hands(0.2), ctx());
        const r = run(z, 216, 300, hands(0.32), ctx());
        expect(r.optical?.action).toBe("zoomIn");
        expect(r.digital).toBeNull();
        const far = run(z, 532, 300, hands(0.6), ctx());
        expect(far.optical?.speed).toBe(3);
    });

    it("crops digitally only once the lens is at its tele end", () => {
        const z = new PinchZoom();
        run(z, 0, 200, hands(0.2), ctx({ opticalPos: 1 }));
        const r = run(z, 216, 400, hands(0.4), ctx({ opticalPos: 1 }));
        expect(r.optical).toBeNull();
        expect(r.digital).toBeGreaterThan(1);
    });

    it("without the remote it is digital only", () => {
        const z = new PinchZoom();
        run(z, 0, 200, hands(0.2), ctx({ opticalReady: false }));
        const r = run(z, 216, 400, hands(0.3), ctx({ opticalReady: false }));
        expect(r.optical).toBeNull();
        expect(r.digital).toBeCloseTo(Math.pow(1.5, 1.5), 1);
    });

    it("bringing the hands together unwinds the crop first, then the lens", () => {
        const z = new PinchZoom();
        const zoomed = ctx({ opticalPos: 1, digital: 2 });
        run(z, 0, 200, hands(0.4), zoomed);
        const r = run(z, 216, 400, hands(0.25), zoomed);
        expect(r.optical).toBeNull();
        expect(r.digital).toBeLessThan(2);
        // Crop back at 1x: now the lens goes wide.
        const r2 = run(z, 632, 300, hands(0.15), ctx({ opticalPos: 1, digital: 1 }));
        expect(r2.optical?.action).toBe("zoomOut");
    });

    it("holding the hands still stops the lens (no drift)", () => {
        const z = new PinchZoom();
        run(z, 0, 200, hands(0.2), ctx());
        expect(run(z, 216, 300, hands(0.2), ctx()).optical).toBeNull();
    });

    it("tolerates pinch flicker, ends after the grace time and says so once", () => {
        const z = new PinchZoom();
        run(z, 0, 200, hands(0.2), ctx());
        expect(z.update(250, hands(0.2, false), ctx(), CFG).active).toBe(true);
        let ended = 0;
        for (let t = 266; t <= 266 + PINCH_ZOOM_GRACE_MS + 50; t += 16) if (z.update(t, hands(0.2, false), ctx(), CFG).ended) ended++;
        expect(ended).toBe(1);
        expect(z.active).toBe(false);
    });

    it("lens speed grows with the distance to the target", () => {
        expect(opticalSpeed(0.1)).toBe(1);
        expect(opticalSpeed(-0.4)).toBe(2);
        expect(opticalSpeed(1)).toBe(3);
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
        expect(e.position(9000 + 2000)).toBeCloseTo(1 - 0.45, 5);
        expect(e.position(60_000)).toBe(0);
    });
});
