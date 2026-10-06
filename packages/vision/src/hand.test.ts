import { describe, expect, it } from "vitest";

import { boxFromUpright, fromUpright, toDisplay, toUpright } from "./geometry.js";
import { classifyHand, fingerExtension, handObservations, mapCanned } from "./hand.js";
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
