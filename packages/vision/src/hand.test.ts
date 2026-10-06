import { describe, expect, it } from "vitest";

import { boxFromUpright, fromUpright, toDisplay, toUpright } from "./geometry.js";
import { classifyHand, fingerExtension, handInFrame, handObservations, HandSmoother, handScale, imagePinchRatio, mapCanned, palmSize, pinchRatio, worldPinchRatio, type Pt3 } from "./hand.js";
import { makeHand, OPEN } from "./testing.js";

const shape = (spec: Parameters<typeof makeHand>[0], canned?: { category: string; score: number }) =>
    classifyHand(makeHand(spec), "right", canned).shape;

describe("finger extension", () => {
    it("reads every finger of an open palm as extended", () => {
        expect(fingerExtension(makeHand(OPEN))).toEqual([true, true, true, true, true]);
    });

    it("reads a fist as all folded, including the thumb across the palm", () => {
        expect(fingerExtension(makeHand({}))).toEqual([false, false, false, false, false]);
    });

    it("is rotation invariant", () => {
        for (const rotate of [0, 45, 90, 180, 270]) {
            expect(fingerExtension(makeHand({ index: true, middle: true, rotate }))).toEqual([false, true, true, false, false]);
        }
    });

    it("is scale invariant (palm-normalised)", () => {
        for (const scale of [0.2, 1, 3]) {
            expect(classifyHand(makeHand({ ...OPEN, scale }), "left").fingers).toBe(5);
        }
    });
});

describe("hand shapes", () => {
    it("counts fingers 0..5", () => {
        expect(classifyHand(makeHand({}), "left").fingers).toBe(0);
        expect(classifyHand(makeHand({ index: true }), "left").fingers).toBe(1);
        expect(classifyHand(makeHand({ index: true, middle: true }), "left").fingers).toBe(2);
        expect(classifyHand(makeHand({ index: true, middle: true, ring: true }), "left").fingers).toBe(3);
        expect(classifyHand(makeHand({ index: true, middle: true, ring: true, pinky: true }), "left").fingers).toBe(4);
        expect(classifyHand(makeHand(OPEN), "left").fingers).toBe(5);
    });

    it("recognises open palm and fist", () => {
        expect(shape(OPEN)).toBe("open_palm");
        expect(shape({})).toBe("fist");
    });

    it("recognises victory, rock, i_love_you and call_me", () => {
        expect(shape({ index: true, middle: true })).toBe("victory");
        expect(shape({ index: true, pinky: true })).toBe("rock");
        expect(shape({ thumb: true, index: true, pinky: true })).toBe("i_love_you");
        expect(shape({ thumb: true, pinky: true })).toBe("call_me");
    });

    it("recognises pinch and ok from the thumb-index distance", () => {
        expect(shape({ index: "pinch" })).toBe("pinch");
        expect(shape({ index: "pinch", middle: true, ring: true, pinky: true })).toBe("ok");
    });

    it("gives the pointing direction in display space", () => {
        expect(shape({ index: true })).toBe("point_up");
        expect(shape({ index: true, rotate: -90 })).toBe("point_left");
        expect(shape({ index: true, rotate: 90 })).toBe("point_right");
    });

    it("tells thumb up from thumb down", () => {
        expect(shape({ thumb: true, rotate: 60 })).toBe("thumb_up");
        expect(shape({ thumb: true, rotate: 240 })).toBe("thumb_down");
    });

    it("maps MediaPipe canned gestures to our ids", () => {
        expect(mapCanned("Thumb_Up")).toBe("thumb_up");
        expect(mapCanned("Closed_Fist")).toBe("fist");
        expect(mapCanned("ILoveYou")).toBe("i_love_you");
        expect(mapCanned("Pointing_Up")).toBe("point_up");
        expect(mapCanned("None")).toBeNull();
        expect(mapCanned("Nope")).toBeNull();
    });

    it("trusts a confident canned label for the shapes it knows", () => {
        expect(shape({}, { category: "Thumb_Up", score: 0.9 })).toBe("thumb_up");
        expect(shape({}, { category: "Thumb_Up", score: 0.4 })).toBe("fist");
    });

    it("keeps our specific shapes over a canned label", () => {
        expect(shape({ index: true, pinky: true }, { category: "ILoveYou", score: 0.9 })).toBe("rock");
    });

    it("emits a finger count observation plus the shape, tagged with the hand", () => {
        const obs = handObservations(classifyHand(makeHand({ index: true, middle: true }), "left"));
        expect(obs.map((o) => o.signal)).toEqual(["fingers_2", "victory"]);
        expect(obs.every((o) => o.hand === "left")).toBe(true);
    });
});

/** Hand fixture scaled into frame-normalised coords around (cx, cy). */
const normHand = (cx: number, cy: number) => makeHand({ ...OPEN, scale: 0.001, at: { x: cx, y: cy } });

describe("off-frame gating", () => {
    it("accepts a hand fully inside the frame", () => {
        expect(handInFrame(normHand(0.5, 0.6))).toBe(true);
    });

    it("rejects a hand whose wrist is outside [0.01, 0.99]", () => {
        expect(handInFrame(normHand(0.5, 0.995))).toBe(false);
        expect(handInFrame(normHand(0.005, 0.6))).toBe(false);
    });

    it("tolerates up to 2 fingertips outside, not 3", () => {
        const lm = normHand(0.5, 0.6);
        const out = (idx: number[]) => lm.map((p, i) => (idx.includes(i) ? { ...p, y: -0.05 } : p));
        expect(handInFrame(out([8, 12]))).toBe(true);
        expect(handInFrame(out([8, 12, 16]))).toBe(false);
    });

    it("rejects a short landmark list", () => {
        expect(handInFrame(normHand(0.5, 0.6).slice(0, 10))).toBe(false);
    });
});

describe("ok / pinch disjointness", () => {
    it("is decided by the middle finger alone", () => {
        // Middle folded -> pinch, even with ring + pinky up.
        expect(shape({ index: "pinch", ring: true, pinky: true })).toBe("pinch");
        // Middle up but ring folded -> neither ok nor pinch.
        const s = shape({ index: "pinch", middle: true });
        expect(s).not.toBe("pinch");
        expect(s).not.toBe("ok");
    });

    it("never returns pinch with the middle finger extended", () => {
        for (const ring of [true, false])
            for (const pinky of [true, false]) {
                const s = shape({ index: "pinch", middle: true, ring, pinky });
                expect(s).not.toBe("pinch");
                if (s === "ok") expect(ring && pinky).toBe(true);
            }
    });
});

describe("pinch from the world ratio", () => {
    const world = (gapM: number): Pt3[] => {
        const w: Pt3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
        w[5] = { x: 0, y: 0, z: 0 };
        w[17] = { x: 0.08, y: 0, z: 0 };
        w[4] = { x: 0.01, y: -0.1, z: 0.01 };
        w[8] = { x: 0.01 + gapM, y: -0.1, z: 0.01 };
        return w;
    };

    it("measures thumb-index distance over palm width in 3D", () => {
        expect(worldPinchRatio(world(0.012))).toBeCloseTo(0.15);
        expect(worldPinchRatio([])).toBeNaN();
    });

    it("uses the calibrated pinchOn threshold instead of the 2D rule", () => {
        const lm = makeHand({ index: "pinch" });
        expect(classifyHand(lm, "right", undefined, { pinchRatio: 0.15, pinchOn: 0.2 }).shape).toBe("pinch");
        expect(classifyHand(lm, "right", undefined, { pinchRatio: 0.15, pinchOn: 0.1 }).shape).not.toBe("pinch");
        const okLm = makeHand({ index: "pinch", middle: true, ring: true, pinky: true });
        expect(classifyHand(okLm, "right", undefined, { pinchRatio: 0.15, pinchOn: 0.2 }).shape).toBe("ok");
        expect(classifyHand(okLm, "right", undefined, { pinchRatio: 0.5, pinchOn: 0.2 }).shape).not.toBe("ok");
    });

    it("sees a side-on pinch in the image when the world view misplaces the thumb", () => {
        const pinchImg = makeHand({ index: "pinch" });
        const i = imagePinchRatio(pinchImg);
        expect(i).toBeLessThan(0.35);
        // World view says ~1 palm apart (MediaPipe's side-on error): the image wins.
        expect(pinchRatio(world(0.08), pinchImg)).toBeCloseTo(i);
        expect(classifyHand(pinchImg, "right", undefined, { pinchRatio: pinchRatio(world(0.08), pinchImg), pinchOn: 0.35 }).shape).toBe("pinch");
    });

    it("does not read a flat open palm as a pinch when only the world view closes", () => {
        const open = makeHand({ thumb: true, index: true, middle: true, ring: true, pinky: true });
        const i = imagePinchRatio(open);
        expect(i).toBeGreaterThan(0.7);
        // World says thumb on index (0.15): the image vetoes it.
        expect(pinchRatio(world(0.012), open)).toBeGreaterThan(0.35);
    });

    it("keeps pointing and fists out of the pinch", () => {
        expect(imagePinchRatio(makeHand({ index: true }))).toBeGreaterThan(0.6);
        expect(imagePinchRatio(makeHand({}))).toBe(Infinity);
        expect(imagePinchRatio([])).toBeNaN();
        expect(pinchRatio([], [])).toBeNaN();
    });

    it("falls back to the 2D rule when the ratio is NaN", () => {
        expect(classifyHand(makeHand({ index: "pinch" }), "right", undefined, { pinchRatio: NaN, pinchOn: 0.01 }).shape).toBe("pinch");
    });
});

describe("hand scale and smoothing", () => {
    it("never scales below the palm, and holds up when the palm is foreshortened", () => {
        const lm = makeHand(OPEN);
        expect(handScale(lm)).toBeGreaterThanOrEqual(palmSize(lm));
        // Squash the wrist -> MCP span (palm tilted towards the camera); fingers stay long.
        const tilted = lm.map((p, i) => (i <= 1 ? { ...p, y: p.y - 70 } : p));
        expect(handScale(tilted)).toBeGreaterThan(palmSize(tilted) * 2);
    });

    it("moves a still, jittery hand < 0.002 per frame and restarts after a 200 ms gap", () => {
        const sm = new HandSmoother();
        const base = normHand(0.5, 0.6);
        let seed = 7;
        const noise = () => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return (seed / 2 ** 31 - 0.5) * 0.005;
        };
        let worst = 0;
        let rawWorst = 0;
        let prev: Pt3[] | null = null;
        let prevRaw: Pt3[] | null = null;
        for (let f = 0; f < 90; f++) {
            const raw = base.map((p) => ({ x: p.x + noise(), y: p.y + noise(), z: 0 }));
            const out = sm.smooth(raw, f * 33).map((p) => ({ x: p.x, y: p.y, z: 0 }));
            const step = (a: Pt3[], b: Pt3[]) => Math.max(...a.map((p, i) => Math.hypot(p.x - (b[i]?.x ?? 0), p.y - (b[i]?.y ?? 0))));
            if (prev && prevRaw) {
                worst = Math.max(worst, step(out, prev));
                rawWorst = Math.max(rawWorst, step(raw, prevRaw));
            }
            prev = out;
            prevRaw = raw;
        }
        expect(worst).toBeLessThan(0.002);
        expect(rawWorst).toBeGreaterThan(0.004);
        const moved = base.map((p) => ({ x: p.x + 0.2, y: p.y }));
        expect(sm.smooth(moved, 90 * 33 + 250)[0]?.x).toBeCloseTo(moved[0]?.x ?? 0);
    });
});

describe("upright transform", () => {
    it("rotates raw camera points clockwise to upright", () => {
        expect(toUpright(0, 0.2, 0.3)).toEqual([0.2, 0.3]);
        expect(toUpright(90, 0, 0)).toEqual([1, 0]);
        expect(toUpright(180, 0.2, 0.3)).toEqual([0.8, 0.7]);
        expect(toUpright(270, 0, 0)).toEqual([0, 1]);
    });

    it("mirrors x after rotating, and scales to pixels", () => {
        expect(toDisplay(0, true, 0.25, 0.5, 1000, 500)).toEqual([750, 250]);
        expect(toDisplay(90, false, 0, 0, 1080, 1920)).toEqual([1080, 0]);
    });

    it("fromUpright inverts toUpright, and boxes map back to raw", () => {
        for (const r of [0, 90, 180, 270] as const) {
            const [u, v] = toUpright(r, 0.2, 0.7);
            const [x, y] = fromUpright(r, u, v);
            expect(x).toBeCloseTo(0.2);
            expect(y).toBeCloseTo(0.7);
        }
        const b = boxFromUpright(90, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
        expect(b.x).toBeCloseTo(0.2);
        expect(b.y).toBeCloseTo(0.6);
        expect(b.w).toBeCloseTo(0.4);
        expect(b.h).toBeCloseTo(0.3);
    });
});
