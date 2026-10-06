import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEED_DOGS, type IdentityProfile } from "@tiksee/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ViewerMemory } from "../memory/db.js";
import { decodeEmbedding, encodeEmbedding, IdentityStore } from "./identities.js";

function vector(seed: number, length = 128): number[] {
    // Float32-representable values so the round trip is exact.
    return Array.from({ length }, (_, i) => Math.fround(Math.sin(seed * 31 + i) * 0.5));
}

function profile(extra: Partial<IdentityProfile> = {}): IdentityProfile {
    return { id: "p1", name: "Dragos", kind: "owner", embeddings: [vector(1), vector(2)], note: "", createdAt: 1000, updatedAt: 1000, ...extra };
}

describe("IdentityStore", () => {
    let dir: string;
    let memory: ViewerMemory;
    let store: IdentityStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "tiksee-id-"));
        memory = ViewerMemory.open(dir);
        store = new IdentityStore(memory.raw, () => 5000);
    });
    afterEach(() => {
        memory.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("encodes and decodes Float32 embeddings exactly", () => {
        const v = vector(7, 384);
        expect(decodeEmbedding(encodeEmbedding(v))).toEqual(v);
    });

    it("round-trips a profile with its embeddings", () => {
        const p = profile();
        store.upsert(p);
        const [loaded] = store.list();
        expect(loaded?.embeddings).toEqual(p.embeddings);
        expect(loaded).toMatchObject({ id: "p1", name: "Dragos", kind: "owner", createdAt: 1000, updatedAt: 5000 });
    });

    it("replaces embeddings on upsert", () => {
        store.upsert(profile());
        store.upsert(profile({ name: "Drago", embeddings: [vector(9)] }));
        expect(store.count()).toBe(1);
        expect(store.embeddingRows()).toBe(1);
        expect(store.get("p1")?.name).toBe("Drago");
        expect(store.get("p1")?.embeddings).toEqual([vector(9)]);
    });

    it("survives a reopen", () => {
        store.upsert(profile());
        memory.close();
        memory = ViewerMemory.open(dir);
        store = new IdentityStore(memory.raw);
        expect(store.get("p1")?.embeddings).toEqual(profile().embeddings);
    });

    it("hard-deletes a profile and every embedding", () => {
        store.upsert(profile());
        store.upsert(profile({ id: "p2", name: "Guest", kind: "person" }));
        expect(store.delete("p1")).toBe(true);
        expect(store.delete("p1")).toBe(false);
        expect(store.list().map((p) => p.id)).toEqual(["p2"]);
        expect(store.embeddingRows()).toBe(2);
        const orphans = memory.raw.prepare("SELECT COUNT(*) AS n FROM identity_embeddings WHERE profile_id = 'p1'").get() as { n: number };
        expect(Number(orphans.n)).toBe(0);
    });

    it("cascades embeddings when a profile row is deleted directly", () => {
        store.upsert(profile());
        memory.raw.prepare("DELETE FROM identity_profiles WHERE id = 'p1'").run();
        expect(store.embeddingRows()).toBe(0);
    });

    it("seeds the dogs once, and never again after an erasure", () => {
        expect(store.seedDogs()).toBe(SEED_DOGS.length);
        const dogs = store.list().filter((p) => p.kind === "dog");
        expect(dogs.map((d) => d.name)).toEqual(SEED_DOGS.map((d) => d.name));
        expect(dogs.every((d) => d.embeddings.length === 0)).toBe(true);
        expect(store.seedDogs()).toBe(0);
        for (const d of dogs) store.delete(d.id);
        expect(store.seedDogs()).toBe(0);
        expect(store.count()).toBe(0);
    });

    it("does not seed when a dog profile already exists", () => {
        store.upsert(profile({ id: "d1", name: "Koro", kind: "dog" }));
        expect(store.seedDogs()).toBe(0);
        expect(store.count()).toBe(1);
    });
});
