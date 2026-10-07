import type { PetAiLevel } from "@tiksee/core";

/**
 * Deterministic floor control for the pet agents (decision Q54). Code — not a
 * model — decides WHO may speak and WHEN; only the chosen pet's agent is
 * called. Every event adds "pressure" to the pets it concerns (with a reason
 * the agent later sees); pressure decays with a 30 s half-life. A pet may take
 * the floor when its pressure crosses the level's threshold, its own cooldown
 * passed, the global gap passed, nobody (streamer, co-host, another pet) is
 * talking, and the hourly budget allows a call. Ties prefer a pet that did not
 * speak last (no pet dominates); pet-to-pet exchanges stop after two turns
 * without new outside input, so pets never loop on each other.
 */

export type Salience =
    | "bigGift"
    | "gift"
    | "follow"
    | "mention"
    | "handled"
    | "wantsToTalk"
    | "petSpoke"
    | "streamerNamed"
    | "streamerSpoke"
    | "cohostSpoke"
    | "chat"
    | "ownerAction"
    | "ownerAppeared";

/** Base weight per event kind (added to the concerned pets' pressure). */
export const SALIENCE: Readonly<Record<Salience, number>> = {
    bigGift: 3,
    gift: 0.7,
    follow: 1.6,
    mention: 3.2,
    handled: 3,
    wantsToTalk: 1.4,
    petSpoke: 0.9,
    streamerNamed: 3.2,
    streamerSpoke: 0.35,
    cohostSpoke: 0.3,
    chat: 0.12,
    ownerAction: 0.8,
    ownerAppeared: 1.6,
};

/** Kinds a "reactive" pet answers; chatty and director answer everything. */
const REACTIVE: ReadonlySet<Salience> = new Set(["bigGift", "follow", "mention", "handled", "streamerNamed", "ownerAppeared"]);
/** Outside input (resets the pet-to-pet exchange counter). */
const EXTERNAL: ReadonlySet<Salience> = new Set(["bigGift", "gift", "follow", "mention", "handled", "streamerNamed", "streamerSpoke", "chat", "ownerAction", "ownerAppeared"]);

export const THRESHOLD: Readonly<Record<PetAiLevel, number>> = { off: Infinity, local: Infinity, reactive: 2.4, chatty: 1.5, director: 1.5 };
/** Hourly call ceiling per level (further capped by `maxCallsPerHour`). */
export const LEVEL_RATE: Readonly<Record<PetAiLevel, number>> = { off: 0, local: 0, reactive: 40, chatty: 150, director: 200 };
export const HALF_LIFE_MS = 30_000;
export const PET_COOLDOWN_MS = 12_000;
export const MIN_GAP_MS = 6_000;
/** Extra global gap per chat message/minute above 20: a busy chat makes pets quieter. */
export const BUSY_GAP_PER_MSG_MS = 120;
export const MAX_GAP_MS = 20_000;
export const STREAMER_HOLD_MS = 1_800;
export const MAX_PET_EXCHANGES = 2;
const MAX_REASONS = 4;
const REASON_TTL_MS = 25_000;
const HOUR_MS = 3_600_000;

export interface Reason {
    at: number;
    kind: Salience;
    /** Code-written description, safe for a prompt (viewer text quoted elsewhere). */
    text: string;
    /** Viewer uniqueId behind it (to pull that viewer's facts), when any. */
    viewer?: string;
}

interface PetFloor {
    pressure: number;
    at: number;
    reasons: Reason[];
    spokeAt: number;
}

export interface FloorState {
    level: PetAiLevel;
    maxCallsPerHour: number;
    /** Chat messages in the last minute. */
    chatPerMinute: number;
    lastStreamerAt: number;
    /** Something is being voiced right now (co-host or a voiced pet line). */
    speaking: boolean;
    /** Live Control: muted, replies paused, pets hidden. */
    quiet: boolean;
}

export interface FloorPick {
    pet: string;
    reasons: Reason[];
    pressure: number;
}

export class Floor {
    #pets = new Map<string, PetFloor>();
    #lastSpeaker: string | null = null;
    #lastLineAt = Number.NEGATIVE_INFINITY;
    #exchanges = 0;
    #calls: number[] = [];

    /** Keep only these pets (the ones in the studio). */
    setPets(pets: readonly string[], now: number): void {
        for (const id of [...this.#pets.keys()]) if (!pets.includes(id)) this.#pets.delete(id);
        for (const id of pets) if (!this.#pets.has(id)) this.#pets.set(id, { pressure: 0, at: now, reasons: [], spokeAt: Number.NEGATIVE_INFINITY });
    }

    get pets(): string[] {
        return [...this.#pets.keys()];
    }

    /** Add pressure to `pets` (all pets when omitted). `scale` multiplies the base weight. */
    push(kind: Salience, reason: Omit<Reason, "kind">, pets?: readonly string[], scale = 1): void {
        if (EXTERNAL.has(kind)) this.#exchanges = 0;
        for (const id of pets ?? this.pets) {
            const p = this.#pets.get(id);
            if (!p) continue;
            this.#decay(p, reason.at);
            p.pressure += SALIENCE[kind] * scale;
            p.reasons.push({ ...reason, kind });
            if (p.reasons.length > MAX_REASONS * 2) p.reasons.splice(0, p.reasons.length - MAX_REASONS * 2);
        }
    }

    pressure(pet: string, now: number): number {
        const p = this.#pets.get(pet);
        if (!p) return 0;
        this.#decay(p, now);
        return p.pressure;
    }

    callsLastHour(now: number): number {
        this.#calls = this.#calls.filter((at) => now - at < HOUR_MS);
        return this.#calls.length;
    }

    /** Global gap before the next pet line, longer when the chat is busy. */
    gapMs(chatPerMinute: number): number {
        return Math.min(MAX_GAP_MS, MIN_GAP_MS + Math.max(0, chatPerMinute - 20) * BUSY_GAP_PER_MSG_MS);
    }

    /** Who may speak now, or null. Does not consume anything (see `granted`). */
    pick(state: FloorState, now: number): FloorPick | null {
        const threshold = THRESHOLD[state.level];
        if (!Number.isFinite(threshold) || state.quiet || state.speaking) return null;
        if (now - state.lastStreamerAt < STREAMER_HOLD_MS) return null;
        if (now - this.#lastLineAt < this.gapMs(state.chatPerMinute)) return null;
        if (this.callsLastHour(now) >= Math.min(LEVEL_RATE[state.level], state.maxCallsPerHour)) return null;
        const reactive = state.level === "reactive";
        let best: FloorPick | null = null;
        for (const [pet, p] of this.#pets) {
            this.#decay(p, now);
            if (now - p.spokeAt < PET_COOLDOWN_MS) continue;
            p.reasons = p.reasons.filter((r) => now - r.at <= REASON_TTL_MS);
            const reasons = reactive ? p.reasons.filter((r) => REACTIVE.has(r.kind)) : p.reasons;
            if (reasons.length === 0) continue;
            const external = reasons.some((r) => EXTERNAL.has(r.kind));
            if (!external && this.#exchanges >= MAX_PET_EXCHANGES) continue;
            let score = p.pressure;
            // Do not hand the floor straight back to the last speaker unless it was addressed.
            if (pet === this.#lastSpeaker && !reasons.some((r) => r.kind === "mention" || r.kind === "handled" || r.kind === "streamerNamed")) score *= 0.6;
            if (score < threshold) continue;
            if (!best || score > best.pressure) best = { pet, reasons: reasons.slice(-MAX_REASONS), pressure: score };
        }
        return best;
    }

    /** The picked pet's agent is being called (spends budget, resets its pressure). */
    granted(pet: string, now: number): void {
        this.#calls.push(now);
        const p = this.#pets.get(pet);
        if (!p) return;
        p.pressure = 0;
        p.reasons = [];
        p.spokeAt = now;
    }

    /** The agent produced a line (or chose silence: spoke=false). */
    spoke(pet: string, spoke: boolean, now: number): void {
        if (!spoke) return;
        this.#lastLineAt = now;
        const wasPet = this.#lastSpeaker !== null && this.#lastSpeaker !== pet;
        this.#lastSpeaker = pet;
        if (wasPet) this.#exchanges += 1;
    }

    #decay(p: PetFloor, now: number): void {
        const dt = Math.max(0, now - p.at);
        if (dt > 0) p.pressure *= 0.5 ** (dt / HALF_LIFE_MS);
        p.at = now;
    }
}
