import type { IdentityProfile } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { SignalBatcher, mergeEmbeddings, radialToAction } from "./actions.js";

describe("SignalBatcher", () => {
    it("reports an arming change once and drains batched events", () => {
        const b = new SignalBatcher<number>();
        expect(b.push([1, 2], false).armChanged).toBe(true);
        expect(b.push([3], false).armChanged).toBe(false);
        expect(b.push([], true).armChanged).toBe(true);
        expect(b.drain()).toEqual([1, 2, 3]);
        expect(b.drain()).toEqual([]);
    });

    it("caps the backlog at 200 events, keeping the newest", () => {
        const b = new SignalBatcher<number>();
        b.push(Array.from({ length: 250 }, (_, i) => i), false);
        const out = b.drain();
        expect(out).toHaveLength(200);
        expect(out[0]).toBe(50);
    });
});

describe("mergeEmbeddings", () => {
    it("appends new samples and keeps the newest 40", () => {
        const profile: IdentityProfile = {
            id: "p",
            name: "Kiri",
            kind: "dog",
            embeddings: Array.from({ length: 38 }, (_, i) => [i]),
            note: "",
            createdAt: 1,
            updatedAt: 1,
        };
        const sample = (v: number) => ({ kind: "dog" as const, embedding: [v], thumbnail: "", quality: 1 });
        const next = mergeEmbeddings(profile, [sample(100), sample(101), sample(102)], 5);
        expect(next.embeddings).toHaveLength(40);
        expect(next.embeddings[0]).toEqual([1]);
        expect(next.embeddings.at(-1)).toEqual([102]);
        expect(next.updatedAt).toBe(5);
        expect(profile.embeddings).toHaveLength(38);
    });
});

describe("radialToAction", () => {
    it("maps engine-side quick actions and leaves caller-side ones null", () => {
        expect(radialToAction("af")).toEqual({ type: "camera", action: "af" });
        expect(radialToAction("cleanFeed")).toEqual({ type: "studio", action: "cleanFeedToggle" });
        expect(radialToAction("photo")).toBeNull();
        expect(radialToAction("arAdd")).toBeNull();
    });
});
