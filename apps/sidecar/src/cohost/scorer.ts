import { eventDiamonds, normaliseForMatch, type ChatEvent } from "@tiksee/core";

/**
 * Deterministic reply priority. Pure and allocation-light: it runs on every
 * chat event during a gift storm, so it must stay well under 5 ms.
 */

export interface ScoreContext {
    /** Lower-cased persona name ("codai"). */
    personaName: string;
    /** Streamer handle without `@`, lower-cased. */
    streamerHandle: string;
    /** First event from this viewer in the current session. */
    firstThisSession: boolean;
    /** Viewer never seen in any previous session (memory db). */
    firstEver: boolean;
    /** Same normalised text already seen recently (any user). */
    duplicate: boolean;
    /** Compiled blocked-word list (core `compileWordList`), applied to normalised text. */
    blocked: RegExp | null;
}

export interface ScoreResult {
    score: number;
    reasons: string[];
    /** Set when the event must never become a reply candidate. */
    excluded?: "duplicate" | "blocked" | "empty" | "kind";
}

/** Romanian and English question openers, matched on diacritic-folded text. */
const QUESTION_WORDS =
    /^(ce|cum|de ce|cine|cand|unde|cat|cata|cati|cate|care|oare|poti|pot|ai|esti|stii|what|how|why|who|when|where|which|can|could|do|does|did|is|are|will|would|should)\b/;

export const SCORE_WEIGHTS = {
    chatBase: 1,
    giftBase: 3,
    giftLog: 2,
    follow: 1.5,
    question: 3,
    firstThisSession: 1,
    firstEver: 2,
    mention: 4,
    follower: 0.5,
    subscriber: 1,
    moderator: 0.5,
    lowContent: -1,
} as const;

/** Half-life of a candidate's priority; an old question is worth less than a fresh one. */
export const RECENCY_HALF_LIFE_MS = 30_000;

export function isQuestion(text: string): boolean {
    const folded = normaliseQuestion(text);
    return folded.includes("?") || QUESTION_WORDS.test(folded);
}

function normaliseQuestion(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
}

export function mentions(text: string, personaName: string, streamerHandle: string): boolean {
    const lower = normaliseQuestion(text);
    if (personaName !== "" && new RegExp(`(^|[^\\p{L}\\p{N}])@?${escape(personaName)}([^\\p{L}\\p{N}]|$)`, "u").test(lower)) {
        return true;
    }
    return streamerHandle !== "" && lower.includes(`@${streamerHandle}`);
}

function escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Base score at the moment the event arrived (no decay). */
export function scoreEvent(event: ChatEvent, context: ScoreContext): ScoreResult {
    if (event.kind !== "chat" && event.kind !== "gift" && event.kind !== "follow") {
        return { score: 0, reasons: [], excluded: "kind" };
    }
    const text = event.text.trim();
    if (event.kind === "chat") {
        if (text === "") return { score: 0, reasons: [], excluded: "empty" };
        if (context.blocked?.test(normaliseForMatch(text))) return { score: 0, reasons: [], excluded: "blocked" };
        if (context.duplicate) return { score: 0, reasons: [], excluded: "duplicate" };
    }

    const reasons: string[] = [];
    let score = 0;

    if (event.kind === "gift") {
        const diamonds = eventDiamonds(event);
        score += SCORE_WEIGHTS.giftBase + SCORE_WEIGHTS.giftLog * Math.log10(1 + diamonds);
        reasons.push("gift");
    } else if (event.kind === "follow") {
        score += SCORE_WEIGHTS.follow;
        reasons.push("follow");
    } else {
        score += SCORE_WEIGHTS.chatBase;
        if (isQuestion(text)) {
            score += SCORE_WEIGHTS.question;
            reasons.push("question");
        }
        if (mentions(text, context.personaName, context.streamerHandle)) {
            score += SCORE_WEIGHTS.mention;
            reasons.push("mention");
        }
        // Emoji-only or one-word noise is rarely worth a spoken reply.
        if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 3) score += SCORE_WEIGHTS.lowContent;
    }

    if (context.firstEver) {
        score += SCORE_WEIGHTS.firstEver;
        reasons.push("first-time");
    } else if (context.firstThisSession) {
        score += SCORE_WEIGHTS.firstThisSession;
        reasons.push("first-today");
    }
    if (event.user.isModerator) {
        score += SCORE_WEIGHTS.moderator;
        reasons.push("moderator");
    }
    if (event.user.isSubscriber) {
        score += SCORE_WEIGHTS.subscriber;
        reasons.push("subscriber");
    } else if (event.user.isFollower) {
        score += SCORE_WEIGHTS.follower;
        reasons.push("follower");
    }

    return { score: Math.max(0, round(score)), reasons };
}

/** Exponential recency decay applied when ranking. */
export function decayed(score: number, at: number, now: number): number {
    const age = Math.max(0, now - at);
    return score * 0.5 ** (age / RECENCY_HALF_LIFE_MS);
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Remembers recently seen normalised texts so copy-paste waves ("first",
 * "❤❤❤") count once. Bounded and time-windowed.
 */
export class DuplicateTracker {
    #seen = new Map<string, number>();
    #windowMs: number;

    constructor(windowMs = 60_000) {
        this.#windowMs = windowMs;
    }

    /** True when this text was already seen inside the window; records it either way. */
    check(text: string, now: number): boolean {
        const key = normaliseForMatch(text).replace(/\s+/g, " ").trim();
        if (key === "") return false;
        const last = this.#seen.get(key);
        this.#seen.set(key, now);
        if (this.#seen.size > 2048) {
            for (const [k, at] of this.#seen) if (now - at > this.#windowMs) this.#seen.delete(k);
        }
        return last !== undefined && now - last < this.#windowMs;
    }
}
