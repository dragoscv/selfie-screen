import { describe, expect, it } from "vitest";

import { StateAnalyzer, type StateInput } from "./states.js";

const BASE: StateInput = {
    jawOpen: 0.05,
    smile: 0.1,
    mouth: { x: 500, y: 400 },
    faceW: 200,
    hands: [],
    objects: [],
    motion: 0,
    headSpeed: 0,
};

function run(a: StateAnalyzer, ms: number, f: (i: number) => Partial<StateInput>, t0 = 0): Set<string> {
    const seen = new Set<string>();
    for (let t = t0, i = 0; t < t0 + ms; t += 33, i++) for (const o of a.update({ ...BASE, ...f(i) }, t)) seen.add(o.signal);
    return seen;
}

describe("states", () => {
    it("detects talking from jaw variance and stays quiet with a still jaw", () => {
        expect(run(new StateAnalyzer(), 1500, (i) => ({ jawOpen: i % 4 < 2 ? 0.35 : 0.05 })).has("talking")).toBe(true);
        expect(run(new StateAnalyzer(), 1500, () => ({ jawOpen: 0.1 })).has("talking")).toBe(false);
    });

    it("detects laughing (smile + jaw oscillation) instead of talking", () => {
        const s = run(new StateAnalyzer(), 1500, (i) => ({ smile: 0.85, jawOpen: i % 4 < 2 ? 0.5 : 0.1 }));
        expect(s.has("laughing")).toBe(true);
        expect(s.has("talking")).toBe(false);
    });

    it("detects drinking: cup near the mouth with a hand on it", () => {
        const cup = { label: "cup", score: 0.8, box: { x: 470, y: 420, w: 60, h: 80 } };
        expect(run(new StateAnalyzer(), 100, () => ({ objects: [cup], hands: [{ x: 500, y: 470 }] })).has("drinking")).toBe(true);
        expect(run(new StateAnalyzer(), 100, () => ({ objects: [cup], hands: [] })).has("drinking")).toBe(false);
        const far = { ...cup, box: { x: 100, y: 900, w: 60, h: 80 } };
        expect(run(new StateAnalyzer(), 100, () => ({ objects: [far], hands: [{ x: 130, y: 940 }] })).has("drinking")).toBe(false);
    });

    it("detects a phone in hand", () => {
        const phone = { label: "cell phone", score: 0.7, box: { x: 300, y: 700, w: 80, h: 140 } };
        expect(run(new StateAnalyzer(), 100, () => ({ objects: [phone], hands: [{ x: 340, y: 770 }] })).has("phone")).toBe(true);
        expect(run(new StateAnalyzer(), 100, () => ({ objects: [phone], hands: [{ x: 900, y: 100 }] })).has("phone")).toBe(false);
    });

    it("raises energy_high with smiles and motion, energy_low when still", () => {
        const hi = new StateAnalyzer();
        expect(run(hi, 6000, () => ({ smile: 1, motion: 0.06, headSpeed: 90 })).has("energy_high")).toBe(true);
        expect(hi.energy).toBeGreaterThan(0.7);
        const lo = new StateAnalyzer();
        expect(run(lo, 6000, () => ({ smile: 0, motion: 0 })).has("energy_low")).toBe(true);
    });
});
