import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ViewerMemory } from "./db.js";
import { bioFor, capMemories, DRIFT_PER_SESSION, MAX_MEMORIES, PetStore, SESSION_MS, SPECIES_TRAITS } from "./pet-store.js";

describe("PetStore", () => {
    let memory: ViewerMemory;
    let store: PetStore;
    let now: number;

    beforeEach(() => {
        now = 1_000_000;
        memory = ViewerMemory.open(":memory:");
        store = new PetStore(memory.raw, () => now);
    });
    afterEach(() => memory.close());

    it("creates species defaults with a code-written bio", () => {
        const parrot = store.ensure("parrot");
        expect(parrot.traits).toEqual(SPECIES_TRAITS.parrot);
        expect(parrot.bio).toBe("A chatty, curious parrot who loves the spotlight.");
        expect(parrot.sessions).toBe(0);
        expect(parrot.memories).toEqual([]);
        const odd = store.ensure("unicorn");
        expect(Object.values(odd.traits)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
        expect(store.ensure("redpanda").bio).toContain("red panda");
        expect(store.ensure("parrot-2").traits).toEqual(SPECIES_TRAITS.parrot);
        for (const pet of Object.keys(SPECIES_TRAITS)) expect(bioFor(pet, SPECIES_TRAITS[pet]!).length).toBeLessThanOrEqual(200);
    });

    it("upserts, lists, resets one or all, and ignores invalid rows", () => {
        const cat = store.ensure("cat");
        store.upsert({ ...cat, likes: { sleep: 1.4 } });
        store.ensure("owl");
        expect(store.list().map((p) => p.pet)).toEqual(["cat", "owl"]);
        expect(store.get("cat")?.likes).toEqual({ sleep: 1.4 });
        memory.raw.prepare("INSERT INTO pet_personality (pet, json, updated_at) VALUES ('bad', '{\"pet\":1}', 0)").run();
        memory.raw.prepare("INSERT INTO pet_personality (pet, json, updated_at) VALUES ('junk', 'not json', 0)").run();
        expect(store.list().map((p) => p.pet)).toEqual(["cat", "owl"]);
        expect(store.get("bad")).toBeNull();
        expect(store.reset("cat")).toBe(1);
        expect(store.get("cat")).toBeNull();
        expect(store.reset("all")).toBe(3);
        expect(store.list()).toEqual([]);
    });

    it("counts a session once per process (and again after 4 h)", () => {
        expect(store.seen("fox").sessions).toBe(1);
        expect(store.seen("fox").sessions).toBe(1);
        now += SESSION_MS;
        expect(store.seen("fox").sessions).toBe(2);
    });

    it("caps memories at 40, dropping the lowest importance/recency score", () => {
        for (let i = 0; i < MAX_MEMORIES; i += 1) store.addMemory("owl", { at: 1000 + i, text: `m${i}`, importance: 0.5 });
        store.addMemory("owl", { at: 2000, text: "big gift", importance: 0.9 });
        const mems = store.get("owl")?.memories ?? [];
        expect(mems).toHaveLength(MAX_MEMORIES);
        expect(mems.some((m) => m.text === "big gift")).toBe(true);
        expect(mems.some((m) => m.text === "m0")).toBe(false);
        // An old but important memory survives a newer trivial one.
        const kept = capMemories([
            ...Array.from({ length: MAX_MEMORIES }, (_, i) => ({ at: 100 + i, text: `t${i}`, importance: 0.2 })),
            { at: 0, text: "first meeting", importance: 1 },
        ]);
        expect(kept.some((m) => m.text === "first meeting")).toBe(true);
    });

    it("drifts traits by experience, never more than 0.02 per session", () => {
        const base = store.ensure("cat").traits;
        expect(store.applyExperience("cat", { petted: 3, praise: 3, startles: 2 })).toBe(true);
        for (let i = 0; i < 50; i += 1) store.applyExperience("cat", { petted: 10, gifts: 10, mentions: 10, startles: 10, novelty: 10 });
        const after = store.get("cat")!.traits;
        expect(after.agreeableness - base.agreeableness).toBeCloseTo(DRIFT_PER_SESSION, 5);
        expect(after.extraversion - base.extraversion).toBeCloseTo(DRIFT_PER_SESSION, 5);
        expect(after.neuroticism - base.neuroticism).toBeCloseTo(DRIFT_PER_SESSION, 5);
        expect(after.openness - base.openness).toBeCloseTo(DRIFT_PER_SESSION, 5);
        expect(after.conscientiousness).toBe(base.conscientiousness);
        expect(store.applyExperience("cat", { petted: 5 })).toBe(false);
        now += SESSION_MS;
        expect(store.applyExperience("cat", { petted: 5 })).toBe(true);
        expect(store.get("cat")!.traits.agreeableness).toBeGreaterThan(after.agreeableness);
        expect(store.get("cat")!.traits.agreeableness - after.agreeableness).toBeLessThanOrEqual(DRIFT_PER_SESSION + 1e-9);
    });

    it("is deterministic and clamps at 1", () => {
        const a = store.ensure("redpanda");
        store.upsert({ ...a, traits: { ...a.traits, agreeableness: 0.995 } });
        store.applyExperience("redpanda", { petted: 3 });
        expect(store.get("redpanda")!.traits.agreeableness).toBe(1);
        expect(store.applyExperience("redpanda", { petted: 3 })).toBe(false);
    });
});
