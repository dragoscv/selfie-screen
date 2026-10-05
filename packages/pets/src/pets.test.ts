import { describe, expect, it } from "vitest";

import { PETS, PET_IDS, petPixelHeight } from "./catalogue.js";
import { OneEuro } from "./one-euro.js";
import { ShoulderTracker, type Landmark } from "./shoulders.js";
import { PetStateMachine } from "./state-machine.js";
import { MOUTH_SHAPES, mouthForViseme, mouthWeights } from "./visemes.js";

describe("visemes", () => {
    it("maps every Azure id 0-21 to one of the 8 mouth shapes", () => {
        for (let id = 0; id <= 21; id++) expect(MOUTH_SHAPES).toContain(mouthForViseme(id));
        expect(mouthForViseme(0)).toBe("rest");
        expect(mouthForViseme(21)).toBe("mbp");
        expect(mouthForViseme(18)).toBe("fv");
        expect(mouthForViseme(99)).toBe("rest");
    });

    it("rests before the first viseme and cross-fades into the next", () => {
        const tl = [
            { id: 2, offsetMs: 100 },
            { id: 21, offsetMs: 200 },
        ];
        expect(mouthWeights(tl, 50).rest).toBe(1);
        expect(mouthWeights(tl, 120).aa).toBe(1);
        const mid = mouthWeights(tl, 170, 60);
        expect(mid.aa).toBeCloseTo(0.5);
        expect(mid.mbp).toBeCloseTo(0.5);
        expect(mouthWeights(tl, 250).mbp).toBe(1);
    });
});

describe("OneEuro", () => {
    it("smooths jitter at rest and follows a step quickly", () => {
        const f = new OneEuro();
        let out = 0;
        for (let i = 0; i < 60; i++) out = f.filter(100 + (i % 2 ? 2 : -2), i * 16.7);
        expect(Math.abs(out - 100)).toBeLessThan(1.5);
        for (let i = 60; i < 90; i++) out = f.filter(300, i * 16.7);
        expect(out).toBeGreaterThan(290);
    });
});

describe("ShoulderTracker", () => {
    const pose = (lx: number, rx: number, y = 0.6): Landmark[] => {
        const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
        lm[11] = { x: lx, y, visibility: 0.9 };
        lm[12] = { x: rx, y, visibility: 0.9 };
        return lm;
    };

    it("puts perches above and outside each shoulder, scaled by span", () => {
        const t = new ShoulderTracker();
        const a = t.update(pose(0.65, 0.35), 1920, 1080, 0);
        expect(a).not.toBeNull();
        if (!a) return;
        expect(a.left.span).toBeCloseTo(576);
        expect(a.left.x).toBeGreaterThan(0.65 * 1920);
        expect(a.right.x).toBeLessThan(0.35 * 1920);
        expect(a.left.y).toBeLessThan(0.6 * 1080);
        expect(a.left.roll).toBeCloseTo(0);
    });

    it("holds the last anchor briefly through a dropout, then lets go", () => {
        const t = new ShoulderTracker();
        t.update(pose(0.6, 0.4), 1000, 1000, 0);
        expect(t.update(null, 1000, 1000, 200)).not.toBeNull();
        expect(t.update(null, 1000, 1000, 700)).toBeNull();
    });
});

describe("PetStateMachine", () => {
    it("talks during speech, reacts to gifts, then returns to talking", () => {
        const m = new PetStateMachine(0, { sleepAfterMs: 60_000, lookEveryMs: 1e9 }, () => 0.5);
        m.send({ type: "speechStart" }, 0);
        expect(m.tick(10)).toBe("talk");
        m.send({ type: "gift", tier: "small" }, 100);
        expect(m.tick(200)).toBe("react");
        expect(m.tick(1400)).toBe("talk");
        m.send({ type: "speechEnd" }, 1500);
        expect(m.tick(1600)).toBe("idle");
        m.send({ type: "gift", tier: "big" }, 2000);
        expect(m.tick(2100)).toBe("dance");
    });

    it("sleeps when quiet and wakes on chat", () => {
        const m = new PetStateMachine(0, { sleepAfterMs: 5000, lookEveryMs: 1e9 }, () => 0.5);
        expect(m.tick(5500)).toBe("sleep");
        m.send({ type: "chat" }, 5600);
        expect(m.tick(5700)).toBe("react");
        expect(m.tick(7000)).toBe("idle");
        expect(m.tick(10_700)).toBe("sleep");
    });

    it("glances around periodically while idle", () => {
        const m = new PetStateMachine(0, { sleepAfterMs: 1e9, lookEveryMs: 1000 }, () => 0.5);
        expect(m.tick(500)).toBe("idle");
        expect(m.tick(1001)).toBe("look");
    });
});

describe("catalogue", () => {
    it("lists seven pets with a sane on-shoulder size", () => {
        expect(PET_IDS).toHaveLength(7);
        for (const id of PET_IDS) {
            const px = petPixelHeight(id, 500);
            expect(px).toBeGreaterThan(150);
            expect(px).toBeLessThan(300);
            expect(PETS[id].id).toBe(id);
        }
    });
});
