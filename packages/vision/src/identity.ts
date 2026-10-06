import type { IdentityProfile } from "@tiksee/core";

/**
 * Enrolled-identity matching (beta). Only explicitly enrolled profiles are
 * matched; an unmatched subject is "unknown" and nothing about it is kept.
 *
 * Thresholds are cosine similarities of L2-normalised embeddings:
 * SFace (people, 128-d) — OpenCV's reference is 0.363; we default to 0.4 for
 * fewer false accepts. DINOv2-S CLS (dogs, 384-d) — 0.6.
 */
export type EmbeddingKind = "person" | "dog";

export const DEFAULT_THRESHOLDS: Record<EmbeddingKind, number> = { person: 0.4, dog: 0.6 };

export function l2normalise(v: ArrayLike<number>): number[] {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) ** 2;
    const n = Math.sqrt(s) || 1;
    return Array.from(v, (x) => x / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    const n = Math.sqrt(na) * Math.sqrt(nb);
    return n > 0 ? dot / n : 0;
}

/** Mean of several embeddings, L2-normalised (one "template" per profile). */
export function centroid(embeddings: readonly (readonly number[])[]): number[] | null {
    const first = embeddings[0];
    if (!first) return null;
    const sum = new Array<number>(first.length).fill(0);
    let n = 0;
    for (const e of embeddings) {
        if (e.length !== first.length) continue;
        const u = l2normalise(e);
        for (let i = 0; i < u.length; i++) sum[i] = (sum[i] ?? 0) + (u[i] ?? 0);
        n++;
    }
    return n > 0 ? l2normalise(sum) : null;
}

export function profileKind(p: IdentityProfile): EmbeddingKind {
    return p.kind === "dog" ? "dog" : "person";
}

export interface Match {
    profileId: string;
    name: string;
    owner: boolean;
    similarity: number;
}

export interface MatchOptions {
    thresholds?: Partial<Record<EmbeddingKind, number>>;
    /** Margin by which the owner wins a near-tie (the owner is by far the most likely face). */
    ownerBias?: number;
}

/**
 * Best profile of the same kind; the score of a profile is max(similarity to
 * its centroid, best single sample). Returns null (unknown) below threshold.
 */
export function matchProfile(embedding: readonly number[], kind: EmbeddingKind, profiles: readonly IdentityProfile[], options: MatchOptions = {}): Match | null {
    const thr = options.thresholds?.[kind] ?? DEFAULT_THRESHOLDS[kind];
    const bias = options.ownerBias ?? 0.03;
    let best: Match | null = null;
    let bestScore = -Infinity;
    for (const p of profiles) {
        if (profileKind(p) !== kind) continue;
        const usable = p.embeddings.filter((e) => e.length === embedding.length);
        if (usable.length === 0) continue;
        const c = centroid(usable);
        let sim = c ? cosine(embedding, c) : -1;
        for (const e of usable) sim = Math.max(sim, cosine(embedding, e));
        if (sim < thr) continue;
        const owner = p.kind === "owner";
        const score = sim + (owner ? bias : 0);
        if (score > bestScore) {
            bestScore = score;
            best = { profileId: p.id, name: p.name, owner, similarity: sim };
        }
    }
    return best;
}

/**
 * Track -> identity stickiness: majority vote over the last `window` match
 * results (null = unknown). Changing identity needs a strict majority, so a
 * single bad crop never flips the name.
 */
export class IdentityVoter {
    readonly #window: number;
    readonly #votes = new Map<number, (Match | null)[]>();
    readonly #current = new Map<number, Match | null>();

    constructor(window = 5) {
        this.#window = window;
    }

    vote(track: number, m: Match | null): Match | null {
        const list = this.#votes.get(track) ?? [];
        list.push(m);
        while (list.length > this.#window) list.shift();
        this.#votes.set(track, list);
        const counts = new Map<string, { n: number; last: Match | null }>();
        for (const v of list) {
            const k = v?.profileId ?? "";
            const c = counts.get(k) ?? { n: 0, last: null };
            c.n++;
            c.last = v;
            counts.set(k, c);
        }
        let top: { n: number; last: Match | null } | null = null;
        for (const c of counts.values()) if (!top || c.n > top.n) top = c;
        // Only a strict majority changes (or refreshes) the identity; ties keep the previous one.
        if (top && top.n * 2 > list.length) this.#current.set(track, top.last);
        return this.#current.get(track) ?? null;
    }

    current(track: number): Match | null {
        return this.#current.get(track) ?? null;
    }

    forget(track: number): void {
        this.#votes.delete(track);
        this.#current.delete(track);
    }
}
