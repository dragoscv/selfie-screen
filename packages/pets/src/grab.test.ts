import { describe, expect, it } from "vitest";

import { GRAB_DROPOUT_MS, HandGrab, PET_SCALE_MAX, PET_SCALE_MIN, type GrabEvent, type GrabPet, type HandInput } from "./grab.js";
import type { Vec3 } from "./space.js";

const PET = { id: "parrot", p: [0, 1, -1] as Vec3, radiusM: 0.09 };

function hand(side: "left" | "right", point: Vec3, pinching = true, present = true): HandInput {
    return { side, present, pinching, point, strength: pinching ? 1 : 0 };
}

/** Run frames at 60 Hz from `t0` for `ms`, collecting events. */
function frames(g: HandGrab, t0: number, ms: number, hands: (t: number) => HandInput[], pets: GrabPet[] = [PET]) {
    const events: GrabEvent[] = [];
    let last = g.update(t0, hands(t0), pets);
    events.push(...last.events);
    for (let t = t0 + 16; t <= t0 + ms; t += 16) {
        last = g.update(t, hands(t), pets);
        events.push(...last.events);
    }
    return { last, events, end: t0 + ms };
}

describe("HandGrab", () => {
    it("grabs a pet near a pinch held >= 50 ms and snaps it into the fingers", () => {
        const g = new HandGrab();
        const pinch: Vec3 = [0.05, 1.02, -1];
        const early = g.update(0, [hand("right", pinch)], [PET]);
        expect(early.held).toBeNull();
        const r = frames(g, 16, 600, () => [hand("right", pinch)]);
        expect(r.events.map((e) => e.kind)).toEqual(["grab"]);
        expect(r.last.held?.pet).toBe("parrot");
        expect(r.last.held?.mode).toBe("drag");
        const t = r.last.held?.target as Vec3;
        expect(Math.hypot(t[0] - pinch[0], t[1] - pinch[1], t[2] - pinch[2])).toBeLessThan(0.005);
    });

    it("ignores a pinch far from every pet", () => {
        const g = new HandGrab();
        const r = frames(g, 0, 500, () => [hand("left", [0.6, 1, -1])]);
        expect(r.last.held).toBeNull();
        expect(r.events).toHaveLength(0);
    });

    it("does not grab with a pinch that started long before reaching the pet (resting hand)", () => {
        const g = new HandGrab();
        const far: Vec3 = [0.6, 1, -1];
        const near: Vec3 = [0.05, 1.02, -1];
        const r = frames(g, 0, 1500, (t) => [hand("right", t < 1000 ? far : near)]);
        expect(r.last.held).toBeNull();
        // Re-pinching near the pet grabs.
        g.update(r.end + 16, [hand("right", near, false)], [PET]);
        expect(frames(g, r.end + 32, 200, () => [hand("right", near)]).last.held?.pet).toBe("parrot");
    });

    it("one-hand push/pull: the pet grows with the hand's apparent size and keeps it on release", () => {
        const g = new HandGrab();
        const at: Vec3 = [0.05, 1.02, -1];
        const sized = (px: number, pinching = true): HandInput => ({ ...hand("right", at, pinching), sizePx: px });
        frames(g, 0, 200, () => [sized(100)]);
        // 3 % wobble stays inside the dead band.
        expect(frames(g, 216, 300, () => [sized(103)]).last.held?.scale).toBeCloseTo(1, 2);
        const big = frames(g, 532, 1500, () => [sized(150)]);
        expect(big.last.held?.scale).toBeGreaterThan(1.35);
        expect(big.last.held?.scale).toBeLessThan(1.5);
        const drop = g.update(big.end + 16, [sized(150, false)], [PET]);
        expect(drop.events.map((e) => e.kind)).toEqual(["resizeEnd", "drop"]);
    });

    it("two-hand resize: a close start spread is floored so the ratio does not explode", () => {
        const g = new HandGrab({ minSpread: 0.2 });
        const at: Vec3 = [0.05, 1.02, -1];
        frames(g, 0, 200, () => [hand("right", at)]);
        // Other hand starts 2 cm away (would be x10 at 0.2 m without the floor), then moves to 0.3 m.
        frames(g, 216, 100, () => [hand("right", at), hand("left", [0.07, 1.02, -1])]);
        const r = frames(g, 332, 1500, () => [hand("right", at), hand("left", [0.35, 1.02, -1])]);
        expect(r.last.held?.scale).toBeGreaterThan(1.4);
        expect(r.last.held?.scale).toBeLessThan(1.6);
    });

    it("honours a per-pet pick radius (body-only)", () => {
        const tight = { ...PET, reachM: 0.03 };
        const r = frames(new HandGrab(), 0, 300, () => [hand("right", [0.05, 1.02, -1])], [tight]);
        expect(r.last.held).toBeNull();
    });

    it("picks with a custom metric (on-screen distance ignores depth error)", () => {
        const screen = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const behind: Vec3 = [0.03, 1.02, -0.65];
        expect(frames(new HandGrab(), 0, 300, () => [hand("right", behind)]).last.held).toBeNull();
        expect(frames(new HandGrab({ metric: screen }), 0, 300, () => [hand("right", behind)]).last.held?.pet).toBe("parrot");
    });

    it("picks the nearest pet when two are in reach", () => {
        const g = new HandGrab();
        const pets = [PET, { id: "fox", p: [0.1, 1, -1] as Vec3, radiusM: 0.09 }];
        const r = frames(g, 0, 200, () => [hand("right", [0.08, 1, -1])], pets);
        expect(r.last.held?.pet).toBe("fox");
    });

    it("keeps the grab through a short hand dropout and drops after a long one", () => {
        const g = new HandGrab();
        const pinch: Vec3 = [0, 1, -1];
        const a = frames(g, 0, 200, () => [hand("right", pinch)]);
        expect(a.last.held).not.toBeNull();
        const b = frames(g, a.end + 16, GRAB_DROPOUT_MS - 40, () => []);
        expect(b.last.held).not.toBeNull();
        expect(b.events).toHaveLength(0);
        const c = frames(g, b.end + 16, 200, () => [hand("right", pinch)]);
        expect(c.last.held).not.toBeNull();
        const d = frames(g, c.end + 16, GRAB_DROPOUT_MS + 60, () => []);
        expect(d.last.held).toBeNull();
        expect(d.events.map((e) => e.kind)).toEqual(["drop"]);
    });

    it("releases on unpinch", () => {
        const g = new HandGrab();
        const pinch: Vec3 = [0, 1, -1];
        const a = frames(g, 0, 200, () => [hand("right", pinch)]);
        const r = g.update(a.end + 16, [hand("right", pinch, false)], [PET]);
        expect(r.held).toBeNull();
        expect(r.events.map((e) => e.kind)).toEqual(["drop"]);
    });

    it("resizes with the other hand by the distance ratio, clamped, and keeps the scale", () => {
        const g = new HandGrab();
        const a: Vec3 = [0, 1, -1];
        const held = frames(g, 0, 200, () => [hand("right", a)]);
        expect(held.last.held?.scale).toBe(1);
        // Second hand pinches 0.2 m away, then spreads to 0.3 m: x1.5.
        const start = frames(g, held.end + 16, 32, () => [hand("right", a), hand("left", [0.2, 1, -1])]);
        expect(start.events.map((e) => e.kind)).toEqual(["resizeStart"]);
        expect(start.last.held?.mode).toBe("resize");
        const spread = frames(g, start.end + 16, 800, () => [hand("right", a), hand("left", [0.3, 1, -1])]);
        expect(spread.last.held?.scale).toBeCloseTo(1.5, 2);
        const huge = frames(g, spread.end + 16, 800, () => [hand("right", a), hand("left", [3, 1, -1])]);
        expect(huge.last.held?.scale).toBeCloseTo(PET_SCALE_MAX, 3);
        const end = frames(g, huge.end + 16, 200, () => [hand("right", a), hand("left", [0.05, 1, -1], false)]);
        expect(end.events.map((e) => e.kind)).toEqual(["resizeEnd"]);
        expect(end.last.held?.mode).toBe("drag");
        expect(end.last.held?.scale).toBeCloseTo(PET_SCALE_MAX, 3);
        // A new resize starts from the kept scale; shrinking clamps at the minimum.
        frames(g, end.end + 16, 32, () => [hand("right", a), hand("left", [0.5, 1, -1])]);
        const tiny = frames(g, end.end + 64, 800, () => [hand("right", a), hand("left", [0.011, 1, -1])]);
        expect(tiny.last.held?.scale).toBeCloseTo(PET_SCALE_MIN, 3);
    });

    it("reports the kept scale on drop and resumes from it on the next grab", () => {
        const g = new HandGrab();
        const a: Vec3 = [0, 1, -1];
        const r = frames(g, 0, 200, () => [hand("right", a)], [{ ...PET, scale: 1.8 }]);
        expect(r.last.held?.scale).toBeCloseTo(1.8);
        const drop = g.update(r.end + 16, [hand("right", a, false)], [{ ...PET, scale: 1.8 }]);
        expect(drop.events[0]).toEqual({ kind: "drop", pet: "parrot", scale: 1.8 });
    });
});
