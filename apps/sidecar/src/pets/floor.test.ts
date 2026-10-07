import { describe, expect, it } from "vitest";

import { Floor, HALF_LIFE_MS, MIN_GAP_MS, PET_COOLDOWN_MS, STREAMER_HOLD_MS, type FloorState } from "./floor.js";

const state = (over: Partial<FloorState> = {}): FloorState => ({
    level: "chatty",
    maxCallsPerHour: 240,
    chatPerMinute: 0,
    lastStreamerAt: 0,
    speaking: false,
    quiet: false,
    ...over,
});

function floor(now = 100_000): Floor {
    const f = new Floor();
    f.setPets(["fox", "cat"], now);
    return f;
}

describe("pet floor control", () => {
    it("gives the floor only to the addressed pet, with its reasons", () => {
        const f = floor();
        f.push("mention", { at: 100_000, text: "ana talked about you", viewer: "ana" }, ["fox"]);
        const pick = f.pick(state(), 100_000);
        expect(pick?.pet).toBe("fox");
        expect(pick?.reasons.map((r) => r.viewer)).toEqual(["ana"]);
    });

    it("never speaks while muted/paused, while someone is voiced, or right after the streamer", () => {
        const f = floor();
        f.push("mention", { at: 100_000, text: "x" }, ["fox"]);
        expect(f.pick(state({ quiet: true }), 100_000)).toBeNull();
        expect(f.pick(state({ speaking: true }), 100_000)).toBeNull();
        expect(f.pick(state({ lastStreamerAt: 100_000 - STREAMER_HOLD_MS + 100 }), 100_000)).toBeNull();
        expect(f.pick(state({ level: "local" }), 100_000)).toBeNull();
        expect(f.pick(state(), 100_000)?.pet).toBe("fox");
    });

    it("reactive pets ignore small talk; chatty ones answer it", () => {
        const f = floor();
        for (let i = 0; i < 20; i++) f.push("chat", { at: 100_000, text: "chat" });
        expect(f.pick(state({ level: "reactive" }), 100_000)).toBeNull();
        expect(f.pick(state({ level: "chatty" }), 100_000)).not.toBeNull();
    });

    it("pressure decays with a 30 s half-life", () => {
        const f = floor();
        f.push("follow", { at: 100_000, text: "x" }, ["fox"]);
        expect(f.pressure("fox", 100_000 + HALF_LIFE_MS)).toBeCloseTo(0.8, 5);
    });

    it("enforces the per-pet cooldown and the global gap", () => {
        const f = floor();
        f.push("mention", { at: 100_000, text: "x" }, ["fox"]);
        f.granted("fox", 100_000);
        f.spoke("fox", true, 100_000);
        f.push("mention", { at: 101_000, text: "y" }, ["fox", "cat"]);
        expect(f.pick(state(), 100_000 + MIN_GAP_MS - 1)).toBeNull();
        expect(f.pick(state(), 100_000 + MIN_GAP_MS)?.pet).toBe("cat");
        f.push("mention", { at: 100_000 + PET_COOLDOWN_MS, text: "z" }, ["fox"]);
        expect(f.pick(state(), 100_000 + PET_COOLDOWN_MS)).not.toBeNull();
    });

    it("a busy chat makes pets quieter", () => {
        const f = floor();
        expect(f.gapMs(10)).toBe(MIN_GAP_MS);
        expect(f.gapMs(80)).toBeGreaterThan(MIN_GAP_MS);
        expect(f.gapMs(10_000)).toBe(20_000);
    });

    it("stops pet-to-pet ping-pong after two exchanges without outside input", () => {
        const f = floor();
        let t = 100_000;
        const turn = (pet: string) => {
            f.granted(pet, t);
            f.spoke(pet, true, t);
            t += PET_COOLDOWN_MS + 1;
        };
        f.push("mention", { at: t, text: "x" }, ["fox"]);
        turn("fox");
        f.push("petSpoke", { at: t, text: "fox spoke" }, ["cat"], 2);
        expect(f.pick(state(), t)?.pet).toBe("cat");
        turn("cat");
        f.push("petSpoke", { at: t, text: "cat spoke" }, ["fox"], 2);
        expect(f.pick(state(), t)?.pet).toBe("fox");
        turn("fox");
        f.push("petSpoke", { at: t, text: "fox spoke" }, ["cat"], 2);
        expect(f.pick(state(), t)).toBeNull();
        f.push("chat", { at: t, text: "viewer" }, ["cat"], 10);
        expect(f.pick(state(), t)?.pet).toBe("cat");
    });

    it("caps calls per hour", () => {
        const f = floor();
        let t = 100_000;
        for (let i = 0; i < 10; i++) {
            f.granted("fox", t);
            t += 1000;
        }
        f.push("mention", { at: t, text: "x" }, ["cat"]);
        expect(f.pick(state({ maxCallsPerHour: 10 }), t)).toBeNull();
        expect(f.pick(state({ maxCallsPerHour: 11 }), t)?.pet).toBe("cat");
    });
});
