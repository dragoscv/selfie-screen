import { describe, expect, it } from "vitest";

import { prosodyPlan } from "./prosody.js";

describe("prosodyPlan", () => {
    it("keeps the tempo when only the pitch changes", () => {
        const p = prosodyPlan(1, 1.25);
        expect(p.rate).toBe(1.25);
        expect(p.serverSpeed * p.rate).toBeCloseTo(1, 3);
    });

    it("combines speed and pitch independently", () => {
        const p = prosodyPlan(1.2, 0.8);
        expect(p.rate).toBe(0.8);
        expect(p.serverSpeed * p.rate).toBeCloseTo(1.2, 3);
    });

    it("is the identity at 1/1", () => {
        expect(prosodyPlan(1, 1)).toEqual({ serverSpeed: 1, rate: 1 });
    });

    it("clamps the server speed to its range", () => {
        expect(prosodyPlan(0.5, 1.6).serverSpeed).toBe(0.5);
        expect(prosodyPlan(1.5, 0.6).serverSpeed).toBe(1.5);
    });

    it("treats invalid input as neutral", () => {
        expect(prosodyPlan(Number.NaN, 0)).toEqual({ serverSpeed: 1, rate: 1 });
    });
});
