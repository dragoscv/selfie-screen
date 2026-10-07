import { petPersonalitySchema, type PetMemory, type PetPersonality, type PetTraits } from "@tiksee/core";

import type { Db } from "./sqlite.js";

/**
 * Persistent pet personalities (decision Q53): OCEAN traits, learned likes,
 * a code-written bio and up to 40 memories per pet, one JSON row per pet in
 * the viewer-memory SQLite file. Rows are zod-validated on read; a row that
 * no longer parses is ignored (and replaced by `ensure`).
 *
 * Traits drift from experience here, deterministically and slowly: at most
 * `DRIFT_PER_SESSION` per trait per session (a session = this process's
 * lifetime, or 4 h of it). The LLM never writes traits or bios; since Q54 a pet's
 * agent may add memories (validated and moderated by the caller), and each pet's
 * own turns (`pet_turns`) are its resumable session.
 */

export interface PetTurn {
    at: number;
    cue: string;
    said: string;
}

/** Turns kept per pet on disk (older ones are pruned). */
export const MAX_TURNS_PER_PET = 200;

export const MAX_MEMORIES = 40;
export const DRIFT_PER_SESSION = 0.02;
export const SESSION_MS = 4 * 3_600_000;
/** Drift step per tally unit; tallies are capped so one call cannot spend the whole budget. */
const STEP = 0.004;
const TALLY_CAP = 3;

type Row = Record<string, unknown>;
type TraitKey = keyof PetTraits;
const TRAIT_KEYS: readonly TraitKey[] = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"];

const t = (o: number, c: number, e: number, a: number, n: number): PetTraits => ({
    openness: o,
    conscientiousness: c,
    extraversion: e,
    agreeableness: a,
    neuroticism: n,
});

export const SPECIES_TRAITS: Readonly<Record<string, PetTraits>> = {
    parrot: t(0.7, 0.4, 0.85, 0.7, 0.3),
    cat: t(0.5, 0.6, 0.25, 0.35, 0.45),
    dragon: t(0.7, 0.4, 0.8, 0.5, 0.35),
    drone: t(0.8, 0.8, 0.5, 0.6, 0.2),
    fox: t(0.8, 0.45, 0.6, 0.55, 0.4),
    owl: t(0.65, 0.8, 0.3, 0.6, 0.3),
    redpanda: t(0.6, 0.5, 0.55, 0.85, 0.35),
};
const UNKNOWN_TRAITS = t(0.5, 0.5, 0.5, 0.5, 0.5);
const SPECIES_LABEL: Readonly<Record<string, string>> = { redpanda: "red panda" };

/** What a pet lived through since the last call (counts, never text). */
export interface PetExperience {
    gifts?: number;
    petted?: number;
    chats?: number;
    mentions?: number;
    laughs?: number;
    startles?: number;
    praise?: number;
    /** Distinct kinds of observation seen (variety feeds openness). */
    novelty?: number;
}

/** Pet ids may carry a suffix for a second pet of the same kind ("parrot-2"). */
export function speciesOf(pet: string): string {
    const base = pet.split(/[-:#]/)[0] ?? pet;
    return SPECIES_TRAITS[base] ? base : "unknown";
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Adjectives for the traits, strongest first (EN; used in the bio and the persona prompt). */
export function traitAdjectives(traits: PetTraits): string[] {
    const out: { word: string; weight: number }[] = [];
    const add = (word: string, weight: number): void => {
        out.push({ word, weight });
    };
    if (traits.extraversion >= 0.65) add("chatty", traits.extraversion);
    if (traits.extraversion <= 0.35) add("quiet", 1 - traits.extraversion);
    if (traits.openness >= 0.65) add("curious", traits.openness);
    if (traits.conscientiousness >= 0.65) add("careful", traits.conscientiousness);
    if (traits.conscientiousness <= 0.35) add("scatterbrained", 1 - traits.conscientiousness);
    if (traits.agreeableness >= 0.65) add("friendly", traits.agreeableness);
    if (traits.agreeableness <= 0.4) add("aloof", 1 - traits.agreeableness);
    if (traits.neuroticism >= 0.55) add("jumpy", traits.neuroticism);
    if (traits.neuroticism <= 0.25) add("calm", 1 - traits.neuroticism);
    out.sort((a, b) => b.weight - a.weight);
    return out.length > 0 ? out.map((o) => o.word) : ["easy-going"];
}

/** A one-line bio written from the traits (EN, <= 200 chars). */
export function bioFor(pet: string, traits: PetTraits): string {
    const species = speciesOf(pet);
    const label = species === "unknown" ? "pet" : (SPECIES_LABEL[species] ?? species);
    const [first, second] = traitAdjectives(traits);
    const adjectives = second ? `${first}, ${second}` : (first ?? "easy-going");
    const top = [...TRAIT_KEYS].filter((k) => k !== "neuroticism").sort((a, b) => traits[b] - traits[a])[0];
    const tail: Record<TraitKey, string> = {
        extraversion: "loves the spotlight",
        openness: "wants to explore everything",
        agreeableness: "loves cuddles and kind words",
        conscientiousness: "likes everything in its place",
        neuroticism: "keeps an eye on the stream",
    };
    const article = /^[aeiou]/i.test(adjectives) ? "An" : "A";
    return `${article} ${adjectives} ${label} who ${tail[top ?? "neuroticism"]}.`.slice(0, 200);
}

export function defaultPersonality(pet: string, now: number): PetPersonality {
    const traits = { ...(SPECIES_TRAITS[speciesOf(pet)] ?? UNKNOWN_TRAITS) };
    return { pet, traits, likes: {}, bio: bioFor(pet, traits), memories: [], sessions: 0, createdAt: now, updatedAt: now };
}

/** Keep at most `MAX_MEMORIES`, dropping the lowest importance*0.7 + recency*0.3. */
export function capMemories(memories: readonly PetMemory[]): PetMemory[] {
    const list = [...memories];
    while (list.length > MAX_MEMORIES) {
        const ats = list.map((m) => m.at);
        const min = Math.min(...ats);
        const span = Math.max(...ats) - min;
        let worst = 0;
        let worstScore = Number.POSITIVE_INFINITY;
        list.forEach((m, i) => {
            const recency = span > 0 ? (m.at - min) / span : 1;
            const score = m.importance * 0.7 + recency * 0.3;
            if (score < worstScore) {
                worstScore = score;
                worst = i;
            }
        });
        list.splice(worst, 1);
    }
    return list;
}

interface SessionState {
    startedAt: number;
    /** Absolute drift already spent this session, per trait. */
    spent: Record<TraitKey, number>;
}

const zeroSpent = (): Record<TraitKey, number> => ({ openness: 0, conscientiousness: 0, extraversion: 0, agreeableness: 0, neuroticism: 0 });

export class PetStore {
    #db: Db;
    #now: () => number;
    #sessions = new Map<string, SessionState>();

    constructor(db: Db, now: () => number = () => Date.now()) {
        this.#db = db;
        this.#now = now;
    }

    list(): PetPersonality[] {
        const rows = this.#db.prepare("SELECT json FROM pet_personality ORDER BY pet").all() as Row[];
        return rows.map((row) => parseRow(row)).filter((p): p is PetPersonality => p !== null);
    }

    get(pet: string): PetPersonality | null {
        const row = this.#db.prepare("SELECT json FROM pet_personality WHERE pet = ?").get(pet) as Row | undefined;
        return row ? parseRow(row) : null;
    }

    upsert(personality: PetPersonality): PetPersonality {
        const valid = petPersonalitySchema.parse({ ...personality, memories: capMemories(personality.memories) });
        this.#db
            .prepare(
                `INSERT INTO pet_personality (pet, json, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(pet) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
            )
            .run(valid.pet, JSON.stringify(valid), valid.updatedAt);
        return valid;
    }

    /** Forget one pet (or every pet with "all"). Returns the number of rows removed. */
    reset(pet: string): number {
        if (pet === "all") {
            this.#sessions.clear();
            this.#db.prepare("DELETE FROM pet_turns").run();
            return Number(this.#db.prepare("DELETE FROM pet_personality").run().changes);
        }
        this.#sessions.delete(pet);
        this.#db.prepare("DELETE FROM pet_turns WHERE pet = ?").run(pet);
        return Number(this.#db.prepare("DELETE FROM pet_personality WHERE pet = ?").run(pet).changes);
    }

    /** Append one agent turn (cue -> line; "" = it chose silence) and prune old ones. */
    addTurn(pet: string, turn: PetTurn): void {
        this.#db.prepare("INSERT INTO pet_turns (pet, at, cue, said) VALUES (?, ?, ?, ?)").run(pet, Math.round(turn.at), turn.cue.slice(0, 300), turn.said.slice(0, 200));
        this.#db
            .prepare("DELETE FROM pet_turns WHERE pet = ? AND id NOT IN (SELECT id FROM pet_turns WHERE pet = ? ORDER BY at DESC, id DESC LIMIT ?)")
            .run(pet, pet, MAX_TURNS_PER_PET);
    }

    /** The pet's newest turns, oldest first (optionally only since `sinceAt`). */
    turns(pet: string, limit: number, sinceAt = 0): PetTurn[] {
        const rows = this.#db
            .prepare("SELECT at, cue, said FROM pet_turns WHERE pet = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?")
            .all(pet, sinceAt, limit) as Row[];
        return rows
            .map((r) => ({ at: Number(r.at), cue: String(r.cue), said: String(r.said) }))
            .reverse();
    }

    /** The stored personality, or a fresh species default (persisted). */
    ensure(pet: string): PetPersonality {
        return this.get(pet) ?? this.upsert(defaultPersonality(pet, this.#now()));
    }

    /**
     * Mark the pet as present: the first call in this process (or after 4 h)
     * opens a new session (sessions + 1, fresh drift budget).
     */
    seen(pet: string): PetPersonality {
        const now = this.#now();
        const current = this.ensure(pet);
        const session = this.#sessions.get(pet);
        if (session && now - session.startedAt < SESSION_MS) return current;
        this.#sessions.set(pet, { startedAt: now, spent: zeroSpent() });
        return this.upsert({ ...current, sessions: current.sessions + 1, updatedAt: now });
    }

    addMemory(pet: string, memory: PetMemory): PetPersonality {
        const current = this.ensure(pet);
        const clean: PetMemory = {
            at: Math.round(memory.at),
            text: memory.text.trim().slice(0, 160) || "something happened",
            importance: clamp01(memory.importance),
        };
        return this.upsert({ ...current, memories: capMemories([...current.memories, clean]), updatedAt: this.#now() });
    }

    /**
     * Move traits from experience: petting/praise -> agreeableness, gifts,
     * mentions and chat -> extraversion, startles -> neuroticism (laughs calm
     * it), variety -> openness. Never more than DRIFT_PER_SESSION per trait
     * per session; clamped to 0..1. Returns true when anything moved.
     */
    applyExperience(pet: string, tallies: PetExperience): boolean {
        const now = this.#now();
        let session = this.#sessions.get(pet);
        if (!session || now - session.startedAt >= SESSION_MS) {
            this.seen(pet);
            session = this.#sessions.get(pet);
        }
        if (!session) return false;
        const n = (v: number | undefined, cap = TALLY_CAP): number => Math.min(cap, Math.max(0, Math.floor(v ?? 0)));
        const want: Record<TraitKey, number> = {
            agreeableness: STEP * n((tallies.petted ?? 0) + (tallies.praise ?? 0)),
            extraversion: STEP * n((tallies.gifts ?? 0) + (tallies.mentions ?? 0)) + (STEP / 2) * n(Math.floor((tallies.chats ?? 0) / 10), 1),
            neuroticism: STEP * n(tallies.startles) - (STEP / 2) * n(tallies.laughs, 2),
            openness: (tallies.novelty ?? 0) >= 3 ? STEP * n((tallies.novelty ?? 0) - 2) : 0,
            conscientiousness: 0,
        };
        const current = this.ensure(pet);
        const traits = { ...current.traits };
        let moved = false;
        for (const key of TRAIT_KEYS) {
            const room = DRIFT_PER_SESSION - session.spent[key];
            if (room <= 0 || want[key] === 0) continue;
            const delta = Math.sign(want[key]) * Math.min(Math.abs(want[key]), room);
            const next = r3(clamp01(traits[key] + delta));
            const applied = Math.abs(next - traits[key]);
            if (applied === 0) continue;
            session.spent[key] = r3(session.spent[key] + applied);
            traits[key] = next;
            moved = true;
        }
        if (!moved) return false;
        this.upsert({ ...current, traits, bio: bioFor(pet, traits), updatedAt: now });
        return true;
    }
}

function parseRow(row: Row): PetPersonality | null {
    if (typeof row.json !== "string") return null;
    try {
        const parsed = petPersonalitySchema.safeParse(JSON.parse(row.json));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
