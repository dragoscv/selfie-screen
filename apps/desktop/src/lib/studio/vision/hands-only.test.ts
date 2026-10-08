import { describe, expect, it, vi } from "vitest";

// The pipeline module imports MediaPipe and the ONNX helpers; only the pure helper is under test.
vi.mock("@mediapipe/tasks-vision", () => ({}));
vi.mock("./depth.js", () => ({}));
vi.mock("./identity.js", () => ({}));
vi.mock("./models.js", () => ({}));

const { handsOnlyPerson } = await import("./pipeline.js");

type Hand = Parameters<typeof handsOnlyPerson>[0][number];

/** A hand of 21 landmarks around (cx, cy) with half-size s (raw normalised coords). */
function hand(cx: number, cy: number, s: number, mpSide: "left" | "right", inFrame = true): Hand {
    const raw = Array.from({ length: 21 }, (_, i) => ({ x: cx + s * Math.cos(i), y: cy + s * Math.sin(i), z: 0 }));
    return { raw, world: [], disp: [], side: mpSide, mpSide, score: 0.9, pinch: 1, pinchWorld: false, inFrame, stale: false, shape: null } as unknown as Hand;
}

const disp = (p: { x: number; y: number }) => ({ x: p.x, y: p.y });

describe("hands-only person (no body or face in view)", () => {
    it("groups the visible hands into one person, one per side", () => {
        const p = handsOnlyPerson([hand(0.3, 0.5, 0.05, "left"), hand(0.7, 0.5, 0.05, "right")], disp);
        expect(p).not.toBeNull();
        expect(p?.hands.map((h) => h.side).sort()).toEqual(["left", "right"]);
        expect(p?.pose).toBeNull();
        expect(p?.face).toBeNull();
        // The box covers both hands with a margin.
        expect(p!.box.x).toBeLessThan(0.25);
        expect(p!.box.x + p!.box.w).toBeGreaterThan(0.75);
    });

    it("keeps the biggest hand when two share a side, ignores hands cut by the frame edge", () => {
        const p = handsOnlyPerson([hand(0.3, 0.5, 0.02, "left"), hand(0.5, 0.5, 0.08, "left"), hand(0.8, 0.5, 0.05, "right", false)], disp);
        expect(p?.hands).toHaveLength(1);
        expect(p?.hands[0]?.raw[0]?.x).toBeCloseTo(0.5 + 0.08, 5);
    });

    it("returns null with no usable hand", () => {
        expect(handsOnlyPerson([hand(0.5, 0.5, 0.05, "left", false)], disp)).toBeNull();
        expect(handsOnlyPerson([], disp)).toBeNull();
    });
});
