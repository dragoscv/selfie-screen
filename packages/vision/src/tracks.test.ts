import { describe, expect, it } from "vitest";

import { pickOwner, SubjectTracker } from "./tracks.js";

const box = (x: number, y = 0.3, w = 0.2, h = 0.3) => ({ x, y, w, h });

describe("SubjectTracker", () => {
    it("keeps stable ids while subjects move", () => {
        const tr = new SubjectTracker<string>();
        tr.update([{ box: box(0.1), data: "a" }, { box: box(0.6), data: "b" }], 0);
        const ids0 = tr.tracks.map((t) => t.id);
        for (let i = 1; i <= 10; i++) tr.update([{ box: box(0.6 - i * 0.005), data: "b" }, { box: box(0.1 + i * 0.01), data: "a" }], i * 33);
        const byData = Object.fromEntries(tr.tracks.map((t) => [t.data, t.id]));
        expect(tr.tracks).toHaveLength(2);
        expect([byData.a, byData.b]).toEqual(ids0);
    });

    it("emits enter after 1 s and leave after 3 s of absence", () => {
        const tr = new SubjectTracker<null>();
        const entered: number[] = [];
        const left: number[] = [];
        for (let t = 0; t <= 1500; t += 100) {
            const ev = tr.update([{ box: box(0.4), data: null }], t);
            entered.push(...ev.entered.map((e) => e.id));
        }
        expect(entered).toEqual([0]);
        for (let t = 1600; t <= 4000; t += 100) left.push(...tr.update([], t).left.map((e) => e.id));
        expect(left).toEqual([]);
        for (let t = 4600; t <= 5000; t += 100) left.push(...tr.update([], t).left.map((e) => e.id));
        expect(left).toEqual([0]);
        expect(tr.tracks).toHaveLength(0);
    });

    it("never reports a flicker shorter than the enter time", () => {
        const tr = new SubjectTracker<null>();
        const events = [tr.update([{ box: box(0.4), data: null }], 0), tr.update([], 100), tr.update([], 5000)];
        expect(events.flatMap((e) => [...e.entered, ...e.left])).toEqual([]);
    });

    it("keeps the id through a short occlusion and does not reuse ids", () => {
        const tr = new SubjectTracker<null>();
        tr.update([{ box: box(0.4), data: null }], 0);
        tr.update([], 1000);
        tr.update([{ box: box(0.42), data: null }], 2000);
        expect(tr.tracks.map((t) => t.id)).toEqual([0]);
        tr.update([{ box: box(0.42), data: null }, { box: box(0.0, 0.7, 0.1, 0.1), data: null }], 2100);
        expect(tr.tracks.map((t) => t.id)).toEqual([0, 1]);
    });
});

describe("pickOwner", () => {
    it("prefers the identity-matched owner track", () => {
        const tr = new SubjectTracker<null>();
        tr.update([{ box: box(0.4, 0.3, 0.3, 0.4), data: null }, { box: box(0.05, 0.6, 0.1, 0.1), data: null }], 0);
        expect(pickOwner(tr.tracks, 100, 1)).toBe(1);
    });

    it("otherwise picks the largest, most central face", () => {
        const tr = new SubjectTracker<null>();
        tr.update([{ box: box(0.02, 0.1, 0.1, 0.12), data: null }, { box: box(0.35, 0.25, 0.3, 0.35), data: null }], 0);
        expect(pickOwner(tr.tracks, 100)).toBe(1);
        expect(pickOwner([], 100)).toBeNull();
    });
});
