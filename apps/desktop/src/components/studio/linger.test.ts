import { describe, expect, it } from "vitest";

import { Linger } from "./context.js";

const key = (v: { id: string }) => v.id;

describe("Linger (overlay flicker guard)", () => {
    it("hides a detection seen for less than showMs", () => {
        const l = new Linger(key, 120, 450);
        expect(l.update([{ id: "a" }], 0)).toEqual([]);
        expect(l.update([{ id: "a" }], 100)).toEqual([]);
        expect(l.update([{ id: "a" }], 130)).toHaveLength(1);
    });

    it("keeps an item through short dropouts and drops it after hideMs", () => {
        const l = new Linger(key, 0, 450);
        const a = { id: "a" };
        expect(l.update([a], 0)).toEqual([a]);
        expect(l.update([], 200)).toEqual([a]);
        expect(l.update([], 440)).toEqual([a]);
        expect(l.update([], 500)).toEqual([]);
    });

    it("returns the same reference while nothing changes", () => {
        const l = new Linger(key, 0, 450);
        const a = { id: "a" };
        const first = l.update([a], 0);
        expect(l.update([a], 16)).toBe(first);
        expect(l.update([], 32)).toBe(first);
    });

    it("an alternating detection (every other frame) stays visible", () => {
        const l = new Linger(key, 0, 450);
        const a = { id: "a" };
        const seen: number[] = [];
        for (let f = 0; f < 60; f++) seen.push(l.update(f % 2 === 0 ? [a] : [], f * 33).length);
        expect(seen.every((n) => n === 1)).toBe(true);
    });
});
