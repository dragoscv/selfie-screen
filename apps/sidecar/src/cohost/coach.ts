import type { ChatEvent, Suggestion } from "@tiksee/core";

/**
 * Teleprompter (WS20-07): watches the chat and nudges the streamer with one
 * short Romanian line at a time. Time is injected; `tick` is driven by a
 * timer in production and called directly in tests.
 */

export const COACH_MIN_GAP_MS = 20_000;
export const UNANSWERED_AFTER_MS = 60_000;
export const QUIET_AFTER_MS = 90_000;
/** Spike = current minute > 3x the rolling average of the previous ones. */
export const SPIKE_FACTOR = 3;
const SPIKE_MIN_MESSAGES = 15;
const HISTORY_MINUTES = 10;

interface OpenQuestion {
    eventId: string;
    uniqueId: string;
    nickname: string;
    text: string;
    at: number;
    suggested: boolean;
}

export class Coach {
    #emit: (suggestion: Suggestion) => void;
    #lastEmit = Number.NEGATIVE_INFINITY;
    #lastChat = 0;
    #quietSuggested = false;
    #questions: OpenQuestion[] = [];
    #pendingThanks = new Map<string, { nickname: string; gifts: number; at: number }>();
    #minuteStart = 0;
    #minuteCount = 0;
    #history: number[] = [];
    #spikeSuggestedAt = Number.NEGATIVE_INFINITY;
    #active = false;
    #seq = 0;

    constructor(emit: (suggestion: Suggestion) => void) {
        this.#emit = emit;
    }

    /** Start coaching once a live (or replay) session has events. */
    start(now: number): void {
        this.#active = true;
        this.#lastChat = now;
        this.#minuteStart = now;
    }

    stop(): void {
        this.#active = false;
        this.#questions = [];
        this.#pendingThanks.clear();
        this.#history = [];
        this.#minuteCount = 0;
    }

    onEvent(event: ChatEvent, question: boolean): void {
        if (!this.#active) this.start(event.at);
        if (event.kind === "chat") {
            this.#lastChat = event.at;
            this.#quietSuggested = false;
            this.#rollMinute(event.at);
            this.#minuteCount += 1;
            if (question) {
                this.#questions.push({
                    eventId: event.id,
                    uniqueId: event.user.uniqueId,
                    nickname: event.user.nickname,
                    text: event.text,
                    at: event.at,
                    suggested: false,
                });
                if (this.#questions.length > 50) this.#questions.shift();
            }
        } else if (event.kind === "gift") {
            const key = event.user.uniqueId;
            const entry = this.#pendingThanks.get(key) ?? { nickname: event.user.nickname, gifts: 0, at: event.at };
            entry.gifts += event.giftCount ?? 1;
            this.#pendingThanks.set(key, entry);
        }
    }

    /** The co-host (or the streamer) answered this viewer; clear their open items. */
    answered(uniqueId: string): void {
        this.#questions = this.#questions.filter((q) => q.uniqueId !== uniqueId);
        this.#pendingThanks.delete(uniqueId);
    }

    /** The streamer said something; open questions older than the speech may be answered. */
    streamerSpoke(at: number): void {
        this.#lastChat = Math.max(this.#lastChat, at - QUIET_AFTER_MS / 2);
    }

    tick(now: number): Suggestion | null {
        if (!this.#active || now - this.#lastEmit < COACH_MIN_GAP_MS) return null;
        this.#rollMinute(now);
        const suggestion = this.#spike(now) ?? this.#unanswered(now) ?? this.#thanks(now) ?? this.#quiet(now);
        if (suggestion) {
            this.#lastEmit = now;
            this.#emit(suggestion);
        }
        return suggestion;
    }

    #make(kind: Suggestion["kind"], text: string, at: number): Suggestion {
        this.#seq += 1;
        return { id: `s-${at.toString(36)}-${this.#seq}`, kind, text, at };
    }

    #unanswered(now: number): Suggestion | null {
        const open = this.#questions.find((q) => !q.suggested && now - q.at >= UNANSWERED_AFTER_MS);
        if (!open) return null;
        open.suggested = true;
        const excerpt = open.text.length > 80 ? `${open.text.slice(0, 77)}…` : open.text;
        return this.#make("unanswered", `${open.nickname} a întrebat acum un minut: „${excerpt}”`, now);
    }

    #thanks(now: number): Suggestion | null {
        const due = [...this.#pendingThanks.entries()].filter(([, v]) => now - v.at >= 15_000);
        if (due.length === 0) return null;
        for (const [key] of due) this.#pendingThanks.delete(key);
        const names = due.slice(0, 3).map(([, v]) => v.nickname);
        const more = due.length > 3 ? ` și încă ${due.length - 3}` : "";
        return this.#make("thanks", `Mulțumește pentru cadouri: ${names.join(", ")}${more}.`, now);
    }

    #quiet(now: number): Suggestion | null {
        if (this.#quietSuggested || now - this.#lastChat < QUIET_AFTER_MS) return null;
        this.#quietSuggested = true;
        return this.#make("quiet", "Chatul e liniștit. Pune o întrebare publicului sau pornește o provocare.", now);
    }

    #spike(now: number): Suggestion | null {
        if (this.#history.length < 3 || now - this.#spikeSuggestedAt < 5 * 60_000) return null;
        const average = this.#history.reduce((a, b) => a + b, 0) / this.#history.length;
        const current = this.#minuteCount;
        if (current < SPIKE_MIN_MESSAGES || current <= SPIKE_FACTOR * Math.max(1, average)) return null;
        this.#spikeSuggestedAt = now;
        return this.#make("spike", "Chatul explodează acum! Profită: salută-i pe toți și cere un follow.", now);
    }

    #rollMinute(now: number): void {
        while (now - this.#minuteStart >= 60_000) {
            this.#history.push(this.#minuteCount);
            if (this.#history.length > HISTORY_MINUTES) this.#history.shift();
            this.#minuteCount = 0;
            this.#minuteStart += 60_000;
        }
    }
}
