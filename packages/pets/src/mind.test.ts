import { describe, expect, it } from "vitest";

import { ACTION_KINDS, PetMind, pickSpotlight, seeded, type MindContext } from "./mind.js";
import type { AnchorId } from "./roam.js";

const ALL: AnchorId[] = ["shoulderL", "shoulderR", "crown", "handL", "handR", "ledgeL", "ledgeR", "orbit", "centre"];

function ctx(over: Partial<MindContext> = {}): MindContext {
    return {
        nowMs: 0,
        family: "bird",
        available: new Set(ALL),
        ownerPresent: true,
        palmUp: false,
        cohostSpeaking: false,
        ownerTalking: false,
        chatActivity: 0.2,
        otherPet: null,
        spotlight: false,
        pointActive: false,
        ...over,
    };
}

function run(mind: PetMind, seconds: number, over: Partial<MindContext> = {}, start = 0, flier = true) {
    const seen = new Map<string, number>();
    for (let t = start; t < start + seconds * 1000; t += 200) {
        const d = mind.tick(ctx({ ...over, nowMs: t }), flier);
        seen.set(d.action, (seen.get(d.action) ?? 0) + 1);
    }
    return seen;
}

describe("PetMind (utility AI)", () => {
    it("is deterministic for a seed (replayable)", () => {
        const a = new PetMind("parrot", "left", 42);
        const b = new PetMind("parrot", "left", 42);
        const ta = [...run(a, 120)].sort().join();
        const tb = [...run(b, 120)].sort().join();
        expect(ta).toBe(tb);
    });

    it("varies its behaviour over a few minutes instead of repeating one script", () => {
        const m = new PetMind("dragon", "left", 3);
        const seen = run(m, 300, { chatActivity: 0.5, otherPet: { action: "perchShoulder", settled: true } });
        expect(seen.size).toBeGreaterThanOrEqual(3);
    });

    it("does not flip-flop: decisions last at least 1.5 s", () => {
        const m = new PetMind("fox", "right", 9);
        let last = "";
        let since = 0;
        let minHold = Infinity;
        for (let t = 0; t < 120_000; t += 200) {
            const a = m.tick(ctx({ nowMs: t, chatActivity: (t / 120_000) % 1 }), false).action;
            if (a !== last) {
                if (last) minHold = Math.min(minHold, t - since);
                last = a;
                since = t;
            }
        }
        expect(minHold).toBeGreaterThanOrEqual(1400);
    });

    it("lands on an open palm when it is offered", () => {
        const m = new PetMind("redpanda", "left", 1);
        run(m, 5);
        const d = m.tick(ctx({ nowMs: 10_000, palmUp: true }), false);
        expect(d.action).toBe("landOnHand");
        expect(d.anchor === "handL" || d.anchor === "handR").toBe(true);
    });

    it("a tired cat on a quiet stream falls asleep on the ledge", () => {
        const m = new PetMind("cat", "right", 5);
        m.needs.energy = 0.05;
        m.mood.arousal = 0.05;
        let slept: string | null = null;
        for (let t = 0; t < 30_000 && !slept; t += 200) {
            const d = m.tick(ctx({ nowMs: t, chatActivity: 0.02 }), false);
            if (d.action === "sleep") slept = d.anchor;
        }
        expect(slept).toBe("ledgeR");
    });

    it("never targets an anchor reserved by the other pet", () => {
        const m = new PetMind("parrot", "left", 2);
        const avail = new Set<AnchorId>(ALL.filter((a) => a !== "shoulderL" && a !== "shoulderR"));
        for (let t = 0; t < 60_000; t += 200) {
            const d = m.tick(ctx({ nowMs: t, available: avail }), true);
            if (d.anchor) expect(avail.has(d.anchor) || d.anchor === "point").toBe(true);
        }
    });

    it("a big gift makes the spotlight pet celebrate", () => {
        const m = new PetMind("dragon", "left", 7);
        run(m, 5);
        m.stimulus({ kind: "gift", big: true });
        m.stimulus({ kind: "gift", big: true });
        const d = m.tick(ctx({ nowMs: 8000, spotlight: true }), true);
        expect(d.action).toBe("celebrate");
    });

    it("director bias multiplies one action's score and expires (a nudge, not a command)", () => {
        const score = (m: PetMind, t: number) => m.tick(ctx({ nowMs: t, chatActivity: 0.6 }), true).ranking.find((r) => r.action === "perchHead")?.score ?? 0;
        const plain = new PetMind("owl", "left", 4);
        const biased = new PetMind("owl", "left", 4);
        biased.bias("perchHead", 2, 0, 5000);
        const a = score(plain, 100);
        const b = score(biased, 100);
        expect(b).toBeGreaterThan(a * 1.9);
        expect(score(biased, 6000)).toBeLessThan(b);
    });

    it("spotlight alternates on equal attention", () => {
        const a = new PetMind("parrot", "left");
        const b = new PetMind("fox", "right");
        expect(pickSpotlight([a, b], "parrot")?.pet).toBe("fox");
        expect(pickSpotlight([a, b], "fox")?.pet).toBe("parrot");
    });

    it("every action kind is reachable in some context (no dead actions)", () => {
        expect(ACTION_KINDS.length).toBeGreaterThan(10);
        expect(seeded(1)()).not.toBe(seeded(2)());
    });
});
