import type { IdentityProfile } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { centroid, cosine, IdentityVoter, l2normalise, matchProfile } from "./identity.js";

/** Deterministic pseudo-random unit vector. */
function vec(seed: number, dim = 128): number[] {
    let s = seed;
    const out: number[] = [];
    for (let i = 0; i < dim; i++) {
        s = (s * 1103515245 + 12345) % 2147483648;
        out.push(s / 2147483648 - 0.5);
    }
    return l2normalise(out);
}

/** Mix a with b: similarity to a falls as w grows. */
const blend = (a: number[], b: number[], w: number) => l2normalise(a.map((x, i) => (1 - w) * x + w * (b[i] ?? 0)));

const profile = (id: string, kind: IdentityProfile["kind"], embeddings: number[][]): IdentityProfile => ({
    id,
    name: id,
    kind,
    embeddings,
    note: "",
    createdAt: 0,
    updatedAt: 0,
});

describe("embedding maths", () => {
    it("cosine of a vector with itself is 1, with its negation -1", () => {
        const a = vec(1);
        expect(cosine(a, a)).toBeCloseTo(1);
        expect(cosine(a, a.map((x) => -x))).toBeCloseTo(-1);
        expect(cosine(a, vec(1, 64))).toBe(0);
    });

    it("centroid is normalised and closer to its members than a stranger", () => {
        const base = vec(10);
        const members = [blend(base, vec(11), 0.3), blend(base, vec(12), 0.3)];
        const c = centroid(members);
        expect(c).not.toBeNull();
        expect(Math.hypot(...(c ?? []))).toBeCloseTo(1);
        expect(cosine(c ?? [], base)).toBeGreaterThan(cosine(members[0] ?? [], base));
        expect(centroid([])).toBeNull();
    });
});

describe("matching", () => {
    const me = vec(100);
    const kara = vec(200, 384);
    const profiles = [
        profile("owner", "owner", [me, blend(me, vec(101), 0.2)]),
        profile("ana", "person", [vec(300)]),
        profile("kara", "dog", [kara]),
    ];

    it("matches the right person and flags the owner", () => {
        const m = matchProfile(blend(me, vec(102), 0.3), "person", profiles);
        expect(m?.profileId).toBe("owner");
        expect(m?.owner).toBe(true);
    });

    it("returns unknown below the person threshold (0.4)", () => {
        expect(matchProfile(vec(999), "person", profiles)).toBeNull();
    });

    it("only compares the same kind and dimension", () => {
        expect(matchProfile(kara, "person", profiles)).toBeNull();
        expect(matchProfile(blend(kara, vec(201, 384), 0.2), "dog", profiles)?.profileId).toBe("kara");
    });

    it("uses the stricter dog threshold (0.6)", () => {
        const weak = blend(kara, vec(202, 384), 0.63);
        const sim = cosine(weak, kara);
        expect(sim).toBeGreaterThan(0.4);
        expect(sim).toBeLessThan(0.6);
        expect(matchProfile(weak, "dog", profiles)).toBeNull();
        expect(matchProfile(weak, "dog", profiles, { thresholds: { dog: 0.4 } })?.profileId).toBe("kara");
    });

    it("prefers the owner on a near tie", () => {
        const twin = blend(me, vec(103), 0.05);
        const tie = [profile("owner", "owner", [me]), profile("twin", "person", [twin])];
        const probe = blend(me, twin, 0.52);
        expect(matchProfile(probe, "person", tie)?.profileId).toBe("owner");
    });
});

describe("identity voter", () => {
    const a = { profileId: "a", name: "A", owner: true, similarity: 0.8 };
    const b = { profileId: "b", name: "B", owner: false, similarity: 0.7 };

    it("sticks to an identity through a single bad match", () => {
        const v = new IdentityVoter(5);
        v.vote(1, a);
        v.vote(1, a);
        v.vote(1, a);
        expect(v.vote(1, b)?.profileId).toBe("a");
        expect(v.vote(1, null)?.profileId).toBe("a");
    });

    it("switches once the majority changes", () => {
        const v = new IdentityVoter(3);
        v.vote(1, a);
        v.vote(1, b);
        expect(v.vote(1, b)?.profileId).toBe("b");
    });

    it("takes a first match immediately and forgets per track", () => {
        const v = new IdentityVoter(5);
        expect(v.vote(7, a)?.profileId).toBe("a");
        v.forget(7);
        expect(v.current(7)).toBeNull();
    });
});
