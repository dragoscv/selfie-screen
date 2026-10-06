import { ACTION_KINDS, type ActionKind } from "./actions.js";
import type { PetId } from "./catalogue.js";

/**
 * Long-lived personality (OCEAN / Big Five, 0..1) layered over the species
 * temperament in mind.ts, plus learned action "likes". Pure and deterministic:
 * the same experience always produces the same drift.
 *
 *   traits  -> action weights, mood baseline, momentum, startle gain
 *   likes   -> plain multipliers on action weights (0.6..1.6)
 *   drift   -> per session, traits move toward what the session's experience
 *              implies by <= 0.02, likes toward enjoyed actions by <= 0.05.
 * Structurally compatible with @tiksee/core PetTraits / PetPersonality.
 */

/** Structural mirror of @tiksee/core `PetTraits`. */
export interface PetTraits {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
}

export const TRAIT_KEYS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as const satisfies readonly (keyof PetTraits)[];

export interface PersonalityState {
    traits: PetTraits;
    /** Learned multiplier per action (0.6..1.6); missing = 1. */
    likes: Partial<Record<ActionKind, number>>;
    sessions: number;
}

/** What the personality layer needs from the mind's Personality (avoids a cycle with mind.ts). */
export interface TraitTarget {
    weights: Partial<Record<ActionKind, number>>;
    drift: Partial<Record<"energy" | "curiosity" | "attention" | "affection" | "play", number>>;
    baseline: { valence: number; arousal: number };
    reactionMs: [number, number];
    /** Multiplier on the current-action momentum bonus (1 = neutral). */
    momentum?: number;
    /** Multiplier on the arousal jump of a startle (1 = neutral). */
    startle?: number;
}

export const NEUTRAL_TRAITS: Readonly<PetTraits> = { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 };

const SPECIES_TRAITS: Readonly<Record<PetId, PetTraits>> = {
    parrot: { openness: 0.8, conscientiousness: 0.35, extraversion: 0.85, agreeableness: 0.6, neuroticism: 0.4 },
    cat: { openness: 0.45, conscientiousness: 0.55, extraversion: 0.25, agreeableness: 0.3, neuroticism: 0.45 },
    dragon: { openness: 0.65, conscientiousness: 0.4, extraversion: 0.75, agreeableness: 0.5, neuroticism: 0.3 },
    drone: { openness: 0.75, conscientiousness: 0.8, extraversion: 0.55, agreeableness: 0.55, neuroticism: 0.2 },
    fox: { openness: 0.75, conscientiousness: 0.35, extraversion: 0.6, agreeableness: 0.55, neuroticism: 0.45 },
    owl: { openness: 0.6, conscientiousness: 0.75, extraversion: 0.3, agreeableness: 0.5, neuroticism: 0.35 },
    redpanda: { openness: 0.55, conscientiousness: 0.45, extraversion: 0.55, agreeableness: 0.85, neuroticism: 0.5 },
};

/** Species-typical traits (a fresh pet). */
export function defaultTraits(pet: PetId): PetTraits {
    return { ...SPECIES_TRAITS[pet] };
}

export function defaultPersonalityState(pet: PetId): PersonalityState {
    return { traits: defaultTraits(pet), likes: {}, sessions: 0 };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : (lo + hi) / 2));
export const LIKE_MIN = 0.6;
export const LIKE_MAX = 1.6;

/** Sanitise an untrusted state (persisted / from the wire). */
export function normaliseState(s: PersonalityState): PersonalityState {
    const traits = { ...NEUTRAL_TRAITS };
    for (const k of TRAIT_KEYS) traits[k] = clamp(s.traits[k], 0, 1);
    const likes: Partial<Record<ActionKind, number>> = {};
    for (const a of ACTION_KINDS) {
        const v = s.likes[a];
        if (typeof v === "number") likes[a] = clamp(v, LIKE_MIN, LIKE_MAX);
    }
    return { traits, likes, sessions: Math.max(0, Math.floor(Number.isFinite(s.sessions) ? s.sessions : 0)) };
}

/**
 * Apply traits and likes to a species personality. Trait effects are relative
 * to `reference` (the species default, by default neutral 0.5), so a fresh pet
 * with its species traits keeps its species temperament exactly.
 */
export function traitsToPersonality<P extends TraitTarget>(base: P, state: PersonalityState, reference: Readonly<PetTraits> = NEUTRAL_TRAITS): P {
    const t = state.traits;
    const d = (k: keyof PetTraits) => clamp(t[k], 0, 1) - reference[k];
    const e = d("extraversion");
    const a = d("agreeableness");
    const o = d("openness");
    const c = d("conscientiousness");
    const n = d("neuroticism");
    const w: Partial<Record<ActionKind, number>> = { ...base.weights };
    const mulW = (k: ActionKind, f: number) => {
        w[k] = (w[k] ?? 1) * Math.max(0.2, f);
    };
    mulW("greetViewers", 1 + 0.8 * e);
    mulW("celebrate", 1 + 0.6 * e);
    mulW("watchCohost", 1 + 0.6 * e);
    mulW("chatter", 1 + 1.0 * e);
    mulW("landOnHand", 1 + 0.8 * a);
    mulW("visitPet", 1 + 0.8 * a);
    mulW("playWithPet", 1 + 0.8 * a);
    mulW("inspectPoint", 1 + 0.8 * o);
    mulW("orbit", 1 + 0.8 * o);
    mulW("sleep", 1 - 0.6 * c);
    mulW("perchShoulder", 1 + 0.3 * c);
    for (const k of ACTION_KINDS) {
        const like = state.likes[k];
        if (typeof like === "number") mulW(k, clamp(like, LIKE_MIN, LIKE_MAX));
        if (w[k] !== undefined) w[k] = clamp(w[k] ?? 1, 0.2, 3);
    }
    const curiosity = base.drift.curiosity ?? 0;
    const out: TraitTarget = {
        ...base,
        weights: w,
        drift: { ...base.drift, curiosity: curiosity * Math.max(0.2, 1 + o) },
        baseline: {
            valence: clamp(base.baseline.valence - 0.3 * n, -1, 1),
            arousal: clamp(base.baseline.arousal + 0.2 * e, 0, 1),
        },
        momentum: (base.momentum ?? 1) * Math.max(0.5, 1 + 0.8 * c),
        startle: (base.startle ?? 1) * Math.max(0.3, 1 + 1.2 * n),
    };
    return out as P;
}

/** Stimuli the learner counts. */
export type LearnStimulus = "gift" | "petted" | "chat" | "wave" | "heart" | "startle" | "laugh";

/** Max trait move per whole session. */
export const TRAIT_STEP = 0.02;
/** Max like move per whole session. */
export const LIKE_STEP = 0.05;
/** A checkpoint every 10 min of session time. */
export const CHECKPOINT_MS = 10 * 60_000;
/** Reference session length: a checkpoint applies `elapsed / SESSION_REF_MS` of the per-session step. */
export const SESSION_REF_MS = 60 * 60_000;
/** Ignore an action's valence until it ran this long (s). */
const LIKE_MIN_SEC = 5;

const CURIOUS: ReadonlySet<ActionKind> = new Set(["inspectPoint", "orbit", "watchCohost", "watchOwner"]);

const step = (from: number, to: number, max: number) => from + clamp(to - from, -max, max);

/**
 * Accumulates one session's experience and turns it into a slow drift of the
 * personality. Feed it from the mind (`observe` per tick, `stimulus` per event).
 */
export class PersonalityLearner {
    #state: PersonalityState;
    readonly #counts: Record<LearnStimulus, number> = { gift: 0, petted: 0, chat: 0, wave: 0, heart: 0, startle: 0, laugh: 0 };
    readonly #time = new Map<ActionKind, { sec: number; valenceSec: number }>();
    #totalSec = 0;
    #valenceSec = 0;
    #switches = 0;
    #lastAction: ActionKind | null = null;
    /** Fraction of the per-session step already applied by checkpoints this session. */
    #applied = 0;
    #lastCheckpoint: number;
    #sinceCheckpointSec = 0;

    constructor(state: PersonalityState, startMs = 0) {
        this.#state = normaliseState(state);
        this.#lastCheckpoint = startMs;
    }

    get state(): PersonalityState {
        return this.#state;
    }

    /** Replace the base state (e.g. loaded from disk); keeps the session's experience. */
    reset(state: PersonalityState, nowMs?: number): void {
        this.#state = normaliseState(state);
        if (nowMs !== undefined) this.#lastCheckpoint = nowMs;
    }

    stimulus(kind: LearnStimulus): void {
        this.#counts[kind]++;
    }

    /** `dtSec` spent doing `action` with mood `valence` (-1..1). */
    observe(action: ActionKind | null, dtSec: number, valence: number): void {
        if (!(dtSec > 0) || !action) return;
        const v = clamp(valence, -1, 1);
        if (this.#lastAction && this.#lastAction !== action) this.#switches++;
        this.#lastAction = action;
        const t = this.#time.get(action) ?? { sec: 0, valenceSec: 0 };
        t.sec += dtSec;
        t.valenceSec += v * dtSec;
        this.#time.set(action, t);
        this.#totalSec += dtSec;
        this.#sinceCheckpointSec += dtSec;
        this.#valenceSec += v * dtSec;
    }

    /** Experience-implied trait targets (null = no evidence for that trait). */
    #targets(): Partial<PetTraits> {
        const c = this.#counts;
        const minutes = this.#totalSec / 60;
        const anyStim = Object.values(c).some((v) => v > 0);
        if (minutes <= 0 && !anyStim) return {};
        const per = (x: number) => x / Math.max(minutes, 1);
        const sat = (x: number) => 1 - Math.exp(-x);
        const out: Partial<PetTraits> = {};
        out.extraversion = 0.2 + 0.7 * sat(per(c.gift + c.chat + c.wave + c.heart + c.laugh) / 2);
        out.agreeableness = 0.3 + 0.6 * sat(per(c.petted + c.wave + c.heart) * 2);
        out.neuroticism = clamp(0.35 + 0.45 * sat(per(c.startle) * 2) - (minutes > 0 ? 0.3 * (this.#valenceSec / this.#totalSec) : 0), 0, 1);
        if (minutes > 0) {
            let curious = 0;
            for (const [a, t] of this.#time) if (CURIOUS.has(a) && t.valenceSec >= 0) curious += t.sec;
            out.openness = 0.3 + 0.6 * Math.min(1, (curious / this.#totalSec) * 3);
            out.conscientiousness = 0.8 - 0.6 * Math.min(1, per(this.#switches) / 6);
        }
        return out;
    }

    /** The state after applying `scale` (0..1) of the per-session step. */
    #drifted(scale: number): PersonalityState {
        const s = this.#state;
        const traits = { ...s.traits };
        const targets = this.#targets();
        for (const k of TRAIT_KEYS) {
            const tg = targets[k];
            if (tg !== undefined) traits[k] = clamp(step(traits[k], tg, TRAIT_STEP * scale), 0, 1);
        }
        const likes = { ...s.likes };
        for (const [a, t] of this.#time) {
            if (t.sec < LIKE_MIN_SEC) continue;
            const mean = t.valenceSec / t.sec;
            const target = clamp(1 + 0.6 * mean, LIKE_MIN, LIKE_MAX);
            likes[a] = clamp(step(likes[a] ?? 1, target, LIKE_STEP * scale), LIKE_MIN, LIKE_MAX);
        }
        return { traits, likes, sessions: s.sessions };
    }

    #clear(): void {
        for (const k of Object.keys(this.#counts) as LearnStimulus[]) this.#counts[k] = 0;
        this.#time.clear();
        this.#totalSec = 0;
        this.#valenceSec = 0;
        this.#switches = 0;
        this.#sinceCheckpointSec = 0;
    }

    /** What `endSession()` would return now (does not commit). */
    snapshot(): PersonalityState {
        const s = this.#drifted(Math.max(0, 1 - this.#applied));
        return { ...s, sessions: s.sessions + 1 };
    }

    /** Commit the session: drift, sessions + 1, start a new session. */
    endSession(nowMs?: number): PersonalityState {
        this.#state = this.snapshot();
        this.#applied = 0;
        this.#clear();
        if (nowMs !== undefined) this.#lastCheckpoint = nowMs;
        return this.#state;
    }

    /**
     * Incremental save: every >= 10 min, apply the drift for the experience so far,
     * scaled by the fraction of a reference session it represents. Returns the
     * new state, or null when it is not time yet.
     */
    checkpoint(nowMs: number): PersonalityState | null {
        if (nowMs - this.#lastCheckpoint < CHECKPOINT_MS) return null;
        const frac = Math.min((this.#sinceCheckpointSec * 1000) / SESSION_REF_MS, 1 - this.#applied);
        this.#lastCheckpoint = nowMs;
        if (frac > 0) {
            this.#state = this.#drifted(frac);
            this.#applied += frac;
        }
        this.#clear();
        return this.#state;
    }
}
