import { ACTION_KINDS, type ActionKind } from "./actions.js";
import type { PetFamily, PetId } from "./catalogue.js";
import { PersonalityLearner, defaultPersonalityState, defaultTraits, traitsToPersonality, type PersonalityState, type PetTraits } from "./personality.js";
import type { AnchorId } from "./roam.js";
import type { PetClip } from "./state-machine.js";

export { ACTION_KINDS, type ActionKind };

/**
 * A pet's mind: needs + mood + personality, choosing what to do with a
 * utility system (Dave Mark's Infinite Axis Utility System, Sims-style needs).
 * Pure, seeded, ticked at 5 Hz; reflexes bypass it via `stimulus()`.
 *
 *   needs (0..1, drift)  energy, curiosity, attention, affection, play
 *   mood (PAD-lite)      valence, arousal: impulses from events, decay to a baseline
 *   actions              each = { where: anchor or null, clip, considerations }
 *   score                product of response curves, compensated for the axis count,
 *                        x personality weight x momentum (current action) x history
 *                        penalty x director bias; pick at random among those within
 *                        10 % of the best (seeded), so two pets never act in lockstep.
 */

export interface Needs {
    energy: number;
    curiosity: number;
    attention: number;
    affection: number;
    play: number;
}

export interface Mood {
    valence: number;
    arousal: number;
}

export interface Personality {
    /** Multipliers per action kind; 1 = neutral. */
    weights: Partial<Record<ActionKind, number>>;
    /** Need drift per minute (+ = grows). */
    drift: Partial<Needs>;
    baseline: Mood;
    /** Reaction delay jitter (ms) so pets do not react in lockstep. */
    reactionMs: [number, number];
    /** Multiplier on the current-action momentum bonus (conscientiousness); default 1. */
    momentum?: number;
    /** Multiplier on a startle's arousal jump (neuroticism); default 1. */
    startle?: number;
}

const BASE: Personality = {
    weights: {},
    drift: { energy: -0.04, curiosity: 0.06, attention: 0.05, affection: 0.03, play: 0.05 },
    baseline: { valence: 0.2, arousal: 0.3 },
    reactionMs: [80, 250],
};

/** Species personalities (research: give each pet a distinct temperament). */
export const PERSONALITIES: Readonly<Record<PetId, Personality>> = {
    parrot: { ...BASE, weights: { perchShoulder: 1.3, watchCohost: 1.4, greetViewers: 1.3, celebrate: 1.2 }, baseline: { valence: 0.4, arousal: 0.55 } },
    cat: {
        ...BASE,
        weights: { restOnLedge: 1.4, sleep: 1.5, watchOwner: 0.8, celebrate: 0.6, playWithPet: 0.7, greetViewers: 0.6 },
        drift: { ...BASE.drift, energy: -0.08 },
        baseline: { valence: 0.1, arousal: 0.2 },
        reactionMs: [180, 450],
    },
    dragon: { ...BASE, weights: { celebrate: 1.5, orbit: 1.4, playWithPet: 1.3, perchHead: 1.2 }, baseline: { valence: 0.35, arousal: 0.6 } },
    drone: { ...BASE, weights: { orbit: 1.5, inspectPoint: 1.4, greetViewers: 1.2, sleep: 0.5 }, baseline: { valence: 0.25, arousal: 0.45 } },
    fox: { ...BASE, weights: { playWithPet: 1.4, landOnHand: 1.2, inspectPoint: 1.3, restOnLedge: 1.1 }, baseline: { valence: 0.3, arousal: 0.5 } },
    owl: {
        ...BASE,
        weights: { perchHead: 1.3, watchOwner: 1.3, sleep: 1.2, celebrate: 0.7, playWithPet: 0.6 },
        drift: { ...BASE.drift, curiosity: 0.03 },
        baseline: { valence: 0.2, arousal: 0.15 },
        reactionMs: [150, 400],
    },
    redpanda: { ...BASE, weights: { perchShoulder: 1.3, landOnHand: 1.4, watchOwner: 1.2, visitPet: 1.3 }, baseline: { valence: 0.45, arousal: 0.35 } },
};

/** What the mind sees each tick. */
export interface MindContext {
    nowMs: number;
    family: PetFamily;
    /** Anchors available now (valid, on screen, not reserved by the other pet). */
    available: ReadonlySet<AnchorId>;
    ownerPresent: boolean;
    /** An open palm is raised (hand perch offered). */
    palmUp: boolean;
    /** The co-host is speaking. */
    cohostSpeaking: boolean;
    /** The owner is talking / laughing. */
    ownerTalking: boolean;
    /** Chat messages per minute (normalised 0..1 by the caller). */
    chatActivity: number;
    /** Another pet exists, and its current action. */
    otherPet: { action: ActionKind; settled: boolean } | null;
    /** This pet holds the spotlight for the current shared stimulus. */
    spotlight: boolean;
    /** Where the owner pointed recently. */
    pointActive: boolean;
}

export interface Decision {
    action: ActionKind;
    anchor: AnchorId | null;
    clip: PetClip;
    score: number;
    /** Top scores for the debug overlay. */
    ranking: readonly { action: ActionKind; score: number }[];
    reason: string;
}

/** Response curves (0..1 in -> 0..1 out). */
const linear = (x: number) => Math.min(1, Math.max(0, x));
const inv = (x: number) => 1 - linear(x);
const logistic = (x: number, mid = 0.5, k = 10) => 1 / (1 + Math.exp(-k * (x - mid)));

interface ActionSpec {
    anchor: (c: MindContext, side: "left" | "right") => AnchorId | null;
    clip: PetClip;
    /** Consideration values (0..1). Empty list = unavailable. */
    score: (n: Needs, m: Mood, c: MindContext, t: PetTraits) => number[];
    /** Minimum ms before this action can repeat. */
    cooldownMs: number;
    /** Allowed for these locomotions only (default all). */
    fliersOnly?: boolean;
}

const own = (side: "left" | "right"): AnchorId => (side === "left" ? "shoulderL" : "shoulderR");
const hand = (side: "left" | "right"): AnchorId => (side === "left" ? "handL" : "handR");
const ledge = (side: "left" | "right"): AnchorId => (side === "left" ? "ledgeL" : "ledgeR");
const has = (c: MindContext, a: AnchorId | null) => a === null || c.available.has(a);

const ACTIONS: Readonly<Record<ActionKind, ActionSpec>> = {
    perchShoulder: {
        anchor: (c, s) => (c.available.has(own(s)) ? own(s) : c.available.has(own(s === "left" ? "right" : "left")) ? own(s === "left" ? "right" : "left") : null),
        clip: "idle",
        score: (n, _m, c) => (c.ownerPresent ? [0.75, logistic(n.affection, 0.3), linear(0.4 + n.energy * 0.6)] : []),
        cooldownMs: 0,
    },
    perchHead: {
        anchor: () => "crown",
        clip: "idle",
        score: (n, m, c) => (c.ownerPresent ? [0.45, logistic(n.curiosity, 0.4), linear(0.3 + m.arousal)] : []),
        cooldownMs: 20_000,
    },
    landOnHand: {
        anchor: (c, s) => (c.available.has(hand(s)) ? hand(s) : c.available.has("handL") ? "handL" : c.available.has("handR") ? "handR" : null),
        clip: "react",
        // An open palm is an explicit invitation: it outranks resting perches (x1.6 below).
        score: (n, _m, c) => (c.palmUp ? [0.95, logistic(n.affection, 0.15)] : []),
        cooldownMs: 3000,
    },
    restOnLedge: {
        anchor: (_c, s) => ledge(s),
        clip: "idle",
        score: (n, _m, c) => [c.ownerPresent ? 0.35 : 0.9, inv(n.attention * 0.7)],
        cooldownMs: 0,
    },
    orbit: {
        anchor: () => "orbit",
        clip: "fly",
        score: (n, m, c) => (c.ownerPresent ? [0.4, logistic(n.play, 0.5), logistic(m.arousal, 0.45), linear(n.energy * 1.2)] : []),
        cooldownMs: 25_000,
        fliersOnly: true,
    },
    watchOwner: {
        anchor: () => null,
        clip: "look",
        score: (n, _m, c) => (c.ownerPresent && c.ownerTalking ? [0.7, logistic(n.attention, 0.3)] : []),
        cooldownMs: 6000,
    },
    watchCohost: {
        anchor: () => null,
        clip: "look",
        score: (n, _m, c) => (c.cohostSpeaking ? [0.75, logistic(n.curiosity, 0.3)] : []),
        cooldownMs: 5000,
    },
    visitPet: {
        anchor: () => null,
        clip: "look",
        score: (n, _m, c) => (c.otherPet ? [0.35, logistic(n.affection, 0.5)] : []),
        cooldownMs: 15_000,
    },
    playWithPet: {
        anchor: () => "orbit",
        clip: "dance",
        score: (n, m, c) =>
            c.otherPet && c.chatActivity < 0.3 ? [0.45, logistic(n.play, 0.6), logistic(m.arousal, 0.4), linear(n.energy * 1.3)] : [],
        cooldownMs: 40_000,
        fliersOnly: true,
    },
    celebrate: {
        anchor: () => null,
        clip: "dance",
        // Dance when happy and lively, or when the chat is buzzing; playful pets dance more.
        score: (n, m, c) =>
            m.valence > 0.35 && (m.arousal > 0.45 || c.chatActivity > 0.35)
                ? [c.spotlight ? 0.95 : 0.5, linear(Math.max(m.arousal, c.chatActivity)), logistic(n.play, 0.35), linear(0.3 + n.energy)]
                : [],
        cooldownMs: 12_000,
    },
    sleep: {
        anchor: (_c, s) => ledge(s),
        clip: "sleep",
        score: (n, m, c) => [inv(n.energy * 1.6), inv(m.arousal * 1.4), c.chatActivity < 0.15 ? 0.9 : 0.2],
        cooldownMs: 30_000,
    },
    inspectPoint: {
        anchor: () => "point",
        clip: "look",
        score: (n, _m, c) => (c.pointActive ? [0.9, logistic(n.curiosity, 0.2)] : []),
        cooldownMs: 2000,
    },
    greetViewers: {
        anchor: () => null,
        clip: "wave",
        score: (n, m, c) => (c.chatActivity > 0.4 ? [0.45, linear(c.chatActivity), logistic(m.valence, 0.3), linear(n.attention)] : []),
        cooldownMs: 30_000,
    },
    chatter: {
        anchor: () => null,
        clip: "talk",
        // Wants to say something: attention need x extraversion, quieter while the owner talks.
        score: (n, _m, c, t) => [0.4, logistic(n.attention, 0.45), linear(0.25 + t.extraversion), c.ownerTalking ? 0.5 : 1],
        cooldownMs: 20_000,
    },
};

/** Actions answering an explicit invitation from the owner or the stream: they beat momentum. */
const INVITATION: Partial<Record<ActionKind, number>> = { landOnHand: 1.6, inspectPoint: 1.5, celebrate: 1.3 };

/** IAUS compensation: a product of k factors is pulled down; restore its scale. */
function compensate(values: number[]): number {
    if (values.length === 0) return 0;
    let s = 1;
    for (const v of values) s *= Math.max(0, Math.min(1, v));
    const mod = 1 - 1 / values.length;
    // Each factor x gets x + (1 - x) * mod * x (Dave Mark's makeup).
    let c = 1;
    for (const v of values) {
        const x = Math.max(0, Math.min(1, v));
        c *= x + (1 - x) * mod * x;
    }
    return Math.max(s, c);
}

/** Mulberry32: tiny seeded PRNG (deterministic replays). */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Events the mind reacts to (stimuli), with salience 0..1. */
export type Stimulus =
    | { kind: "gift"; big: boolean }
    | { kind: "follow" }
    | { kind: "chat" }
    | { kind: "laugh" }
    | { kind: "wave" }
    | { kind: "heart" }
    | { kind: "petted" }
    | { kind: "startle" }
    /** Picked up by the owner's hand (counts as being petted). */
    | { kind: "grabbed" }
    /** Let go by the owner's hand (a small jolt). */
    | { kind: "dropped" };

export interface MindOptions {
    /** Learned personality (traits + likes); default = the species traits. */
    personality?: PersonalityState;
    /** Session start (performance clock) for checkpoints. */
    startMs?: number;
}

export class PetMind {
    readonly pet: PetId;
    readonly side: "left" | "right";
    readonly needs: Needs = { energy: 0.8, curiosity: 0.5, attention: 0.4, affection: 0.6, play: 0.4 };
    readonly mood: Mood;
    readonly #rand: () => number;
    readonly #learner: PersonalityLearner;
    #personality: Personality;
    #decision: Decision | null = null;
    #since = 0;
    #last = 0;
    readonly #lastRun = new Map<ActionKind, number>();
    /** Director (LLM) bias: action -> multiplier until a time. */
    readonly #bias = new Map<ActionKind, { k: number; until: number }>();
    readonly #log: { at: number; action: ActionKind; score: number; reason: string }[] = [];

    constructor(pet: PetId, side: "left" | "right", seed = 1, options: MindOptions = {}) {
        this.pet = pet;
        this.side = side;
        this.#learner = new PersonalityLearner(options.personality ?? defaultPersonalityState(pet), options.startMs ?? 0);
        this.#personality = traitsToPersonality(PERSONALITIES[pet], this.#learner.state, defaultTraits(pet));
        this.mood = { ...this.#personality.baseline };
        this.#rand = seeded(seed);
    }

    /** Species temperament x learned traits and likes. */
    get personality(): Personality {
        return this.#personality;
    }

    /** Committed learned state (base + 10-min checkpoints); save this. */
    get personalityState(): PersonalityState {
        return this.#learner.state;
    }

    get traits(): PetTraits {
        return this.#learner.state.traits;
    }

    /** Load a learned personality (keeps the current session's experience). */
    setPersonality(state: PersonalityState): void {
        this.#learner.reset(state);
        this.#personality = traitsToPersonality(PERSONALITIES[this.pet], this.#learner.state, defaultTraits(this.pet));
    }

    /** Incremental drift every >= 10 min; returns the new state or null. */
    checkpoint(nowMs: number): PersonalityState | null {
        const s = this.#learner.checkpoint(nowMs);
        if (s) this.#personality = traitsToPersonality(PERSONALITIES[this.pet], s, defaultTraits(this.pet));
        return s;
    }

    /** Commit the session's drift (sessions + 1) and return the state to save. */
    endSession(nowMs?: number): PersonalityState {
        const s = this.#learner.endSession(nowMs);
        this.#personality = traitsToPersonality(PERSONALITIES[this.pet], s, defaultTraits(this.pet));
        return s;
    }

    /**
     * The stage asked the LLM for a line: end the current chatter decision so the
     * pet moves on (its cooldown then keeps it quiet for a while).
     */
    consumeChatter(nowMs: number): void {
        if (this.#decision?.action !== "chatter") return;
        this.#lastRun.set("chatter", nowMs);
        this.needs.attention = Math.max(0, this.needs.attention - 0.3);
        this.#decision = null;
    }

    get decision(): Decision | null {
        return this.#decision;
    }

    get log(): readonly { at: number; action: ActionKind; score: number; reason: string }[] {
        return this.#log;
    }

    /** Director nudge: multiply `action` by `k` for `ttlMs`. Never a direct command. */
    bias(action: ActionKind, k: number, nowMs: number, ttlMs: number): void {
        this.#bias.set(action, { k: Math.min(Math.max(k, 0.3), 2), until: nowMs + ttlMs });
    }

    /** Event impulses on needs and mood (reflex-level, immediate). */
    stimulus(s: Stimulus): void {
        const m = this.mood;
        const n = this.needs;
        const bump = (v: number, a: number) => {
            m.valence = Math.max(-1, Math.min(1, m.valence + v));
            m.arousal = Math.max(0, Math.min(1, m.arousal + a));
        };
        switch (s.kind) {
            case "gift":
                bump(s.big ? 0.5 : 0.25, s.big ? 0.6 : 0.3);
                n.attention = Math.max(0, n.attention - 0.2);
                n.energy = Math.min(1, n.energy + 0.1);
                break;
            case "follow":
                bump(0.15, 0.15);
                break;
            case "chat":
                bump(0.02, 0.04);
                n.curiosity = Math.min(1, n.curiosity + 0.02);
                break;
            case "laugh":
                bump(0.2, 0.25);
                n.energy = Math.min(1, n.energy + 0.2); // wakes them up
                break;
            case "wave":
            case "heart":
                bump(0.25, 0.2);
                n.affection = Math.max(0, n.affection - 0.3);
                n.energy = Math.min(1, n.energy + 0.25);
                break;
            case "petted":
            case "grabbed":
                bump(0.3, -0.1);
                n.affection = Math.max(0, n.affection - 0.5);
                break;
            case "startle":
                bump(-0.1, 0.5 * (this.#personality.startle ?? 1));
                n.energy = Math.min(1, n.energy + 0.3);
                break;
            case "dropped":
                bump(0, 0.15 * (this.#personality.startle ?? 1));
                break;
        }
        const learn = s.kind === "grabbed" ? "petted" : s.kind === "follow" ? "gift" : s.kind === "dropped" ? null : s.kind;
        if (learn) this.#learner.stimulus(learn);
    }

    /** Drift needs and decay mood toward the baseline. */
    #drift(dtSec: number): void {
        this.#learner.observe(this.#decision?.action ?? null, dtSec, this.mood.valence);
        const d = this.personality.drift;
        const n = this.needs;
        const perMin = dtSec / 60;
        for (const k of Object.keys(n) as (keyof Needs)[]) n[k] = Math.max(0, Math.min(1, n[k] + (d[k] ?? 0) * perMin));
        const b = this.personality.baseline;
        const k = 1 - Math.exp(-dtSec / 12);
        this.mood.valence += (b.valence - this.mood.valence) * k;
        this.mood.arousal += (b.arousal - this.mood.arousal) * k;
        // Running an action satisfies its need.
        const a = this.#decision?.action;
        if (a === "sleep") n.energy = Math.min(1, n.energy + 0.25 * perMin * 4);
        if (a === "perchShoulder" || a === "landOnHand" || a === "perchHead") n.affection = Math.max(0, n.affection - 0.1 * perMin * 4);
        if (a === "orbit" || a === "playWithPet") {
            n.play = Math.max(0, n.play - 0.3 * perMin * 4);
            n.energy = Math.max(0, n.energy - 0.1 * perMin * 4);
        }
        if (a === "watchOwner" || a === "watchCohost" || a === "inspectPoint") n.curiosity = Math.max(0, n.curiosity - 0.2 * perMin * 4);
        if (a === "greetViewers") n.attention = Math.max(0, n.attention - 0.4 * perMin * 4);
    }

    /** Re-evaluate. Call at ~5 Hz; returns the current decision (possibly unchanged). */
    tick(c: MindContext, flier: boolean): Decision {
        const dt = this.#last ? Math.min((c.nowMs - this.#last) / 1000, 1) : 0;
        this.#last = c.nowMs;
        this.#drift(dt);
        const ranking: { action: ActionKind; score: number; anchor: AnchorId | null }[] = [];
        for (const kind of ACTION_KINDS) {
            const spec = ACTIONS[kind];
            if (spec.fliersOnly && !flier) continue;
            const anchor = spec.anchor(c, this.side);
            if (!has(c, anchor)) continue;
            const considerations = spec.score(this.needs, this.mood, c, this.traits);
            if (considerations.length === 0) continue;
            let s = compensate(considerations) * (this.personality.weights[kind] ?? 1) * (INVITATION[kind] ?? 1);
            // Urgent needs override habits: an exhausted pet must sleep even if it was perched.
            if (kind === "sleep" && this.needs.energy < 0.15) s *= 1.8;
            const cur = this.#decision?.action === kind;
            if (cur) {
                // Momentum (no flip-flopping), fading into boredom after ~20 s on the same thing.
                const held = c.nowMs - this.#since;
                s *= (1 + 0.25 * (this.#personality.momentum ?? 1)) * Math.max(0.45, 1 - Math.max(0, held - 20_000) / 60_000);
            }
            const lastRun = this.#lastRun.get(kind) ?? -Infinity;
            if (!cur && c.nowMs - lastRun < spec.cooldownMs) s *= 0.2;
            if (!cur && c.nowMs - lastRun < 60_000) s *= 0.75; // variety
            const b = this.#bias.get(kind);
            // Director bias, and it also lifts the cooldown/variety penalty for that action.
            if (b && b.until > c.nowMs) s *= b.k * (!cur && c.nowMs - lastRun < 60_000 ? 1.4 : 1);
            ranking.push({ action: kind, score: s, anchor });
        }
        ranking.sort((a, b) => b.score - a.score);
        const best = ranking[0];
        if (!best) {
            const fallback: Decision = { action: "restOnLedge", anchor: this.side === "left" ? "ledgeL" : "ledgeR", clip: "idle", score: 0, ranking: [], reason: "nothing available" };
            this.#decision = fallback;
            return fallback;
        }
        // Weighted random among the near-best (within 10 %), seeded.
        const pool = ranking.filter((r) => r.score >= best.score * 0.9);
        const total = pool.reduce((s, r) => s + r.score, 0);
        let roll = this.#rand() * total;
        let pick = best;
        for (const r of pool) {
            roll -= r.score;
            if (roll <= 0) {
                pick = r;
                break;
            }
        }
        // Commit to an action for at least 1.5 s unless something scores much higher.
        const cur = this.#decision;
        if (cur && cur.action !== pick.action && c.nowMs - this.#since < 1500 && pick.score < cur.score * 1.5) {
            this.#decision = { ...cur, ranking: ranking.slice(0, 5).map(({ action, score }) => ({ action, score })) };
            return this.#decision;
        }
        if (!cur || cur.action !== pick.action) {
            this.#since = c.nowMs;
            this.#lastRun.set(pick.action, c.nowMs);
            const runner = ranking.find((r) => r.action !== pick.action);
            const reason = runner ? `${pick.action} ${pick.score.toFixed(2)} > ${runner.action} ${runner.score.toFixed(2)}` : pick.action;
            this.#log.push({ at: c.nowMs, action: pick.action, score: pick.score, reason });
            if (this.#log.length > 40) this.#log.shift();
        }
        this.#decision = {
            action: pick.action,
            anchor: pick.anchor,
            clip: ACTIONS[pick.action].clip,
            score: pick.score,
            ranking: ranking.slice(0, 5).map(({ action, score }) => ({ action, score })),
            reason: this.#log.at(-1)?.reason ?? pick.action,
        };
        return this.#decision;
    }
}

/**
 * Spotlight: for a shared stimulus only one pet leads; the other echoes later.
 * The leader is whoever has the higher attention need, alternating on ties.
 */
export function pickSpotlight(minds: readonly PetMind[], lastLeader: string | null): PetMind | null {
    if (minds.length === 0) return null;
    const sorted = [...minds].sort((a, b) => b.needs.attention - a.needs.attention || (a.pet === lastLeader ? 1 : -1));
    return sorted[0] ?? null;
}
