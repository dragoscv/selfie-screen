import type { ChatEvent, ReplyItem, ReplyStatus } from "@tiksee/core";

import { decayed } from "./scorer.js";

/** What produced an item; decides who may speak it and whether it costs a reply token. */
export type EntryKind = "ai" | "thanks" | "greeting" | "read" | "manual";

export interface QueueEntry {
    item: ReplyItem;
    kind: EntryKind;
    event?: ChatEvent;
    /** Streamer approved it (approve mode), possibly with edited text. */
    approved: boolean;
    /** Sentences waiting to be spoken, in order. */
    parts: string[];
    /** The LLM stream is still producing sentences for this item. */
    streaming: boolean;
    /** Unspoken items are skipped after this epoch ms. */
    expiresAt?: number;
    /** TTS voice for this entry (a pet's own voice); absent = settings.voice.voice. */
    voice?: string;
    /** Tempo / pitch for this entry (a pet's prosody); absent = settings.voice.speed / 1. */
    speed?: number;
    pitch?: number;
}

const ACTIVE: ReadonlySet<ReplyStatus> = new Set(["pending", "drafting", "ready", "speaking"]);
/** Finished items kept for the UI history strip. */
const KEEP_FINISHED = 10;
/** Coalesce `replyQueue` broadcasts to at most 10 per second. */
export const EMIT_INTERVAL_MS = 100;

export function isActive(status: ReplyStatus): boolean {
    return ACTIVE.has(status);
}

/**
 * Ordered store of reply candidates and their lifecycle. It holds no policy
 * beyond capacity: the co-host engine decides what to draft and speak; this
 * class ranks, caps, expires and tells the renderer.
 */
export class ReplyQueue {
    #entries = new Map<string, QueueEntry>();
    #maxActive: number;
    #onChange: (items: ReplyItem[]) => void;
    #timer: NodeJS.Timeout | null = null;
    #lastEmit = 0;
    #seq = 0;

    constructor(maxActive: number, onChange: (items: ReplyItem[]) => void) {
        this.#maxActive = maxActive;
        this.#onChange = onChange;
    }

    setMaxActive(max: number): void {
        this.#maxActive = max;
    }

    nextId(): string {
        this.#seq += 1;
        return `r-${Date.now().toString(36)}-${this.#seq.toString(36)}`;
    }

    get(id: string): QueueEntry | undefined {
        return this.#entries.get(id);
    }

    entries(): QueueEntry[] {
        return [...this.#entries.values()];
    }

    activeCount(): number {
        let n = 0;
        for (const entry of this.#entries.values()) if (isActive(entry.item.status)) n += 1;
        return n;
    }

    /**
     * Add an entry. When full, the lowest-ranked PENDING entry is evicted if
     * the newcomer outranks it; otherwise the newcomer is rejected.
     */
    add(entry: QueueEntry, now: number): boolean {
        if (this.activeCount() >= this.#maxActive) {
            const victim = this.#lowestPending(now);
            if (!victim || decayed(victim.item.score, victim.item.at, now) >= entry.item.score) return false;
            victim.item = { ...victim.item, status: "skipped" };
        }
        this.#entries.set(entry.item.id, entry);
        this.#trim();
        this.changed();
        return true;
    }

    update(id: string, patch: Partial<Pick<ReplyItem, "status" | "draft" | "score" | "reasons">>): QueueEntry | undefined {
        const entry = this.#entries.get(id);
        if (!entry) return undefined;
        entry.item = { ...entry.item, ...patch };
        if (patch.status && !isActive(patch.status)) {
            entry.parts = [];
            entry.streaming = false;
            this.#trim();
        }
        this.changed();
        return entry;
    }

    /** Highest-ranked pending entry of the given kinds. */
    topPending(now: number, kinds: ReadonlySet<EntryKind>): QueueEntry | undefined {
        let best: QueueEntry | undefined;
        let bestScore = -Infinity;
        for (const entry of this.#entries.values()) {
            if (entry.item.status !== "pending" || !kinds.has(entry.kind)) continue;
            const score = decayed(entry.item.score, entry.item.at, now);
            if (score > bestScore) {
                best = entry;
                bestScore = score;
            }
        }
        return best;
    }

    /** Highest-ranked `ready` entry that `eligible` accepts; ties go to the oldest. */
    nextSpeakable(now: number, eligible: (entry: QueueEntry) => boolean): QueueEntry | undefined {
        let best: QueueEntry | undefined;
        let bestScore = -Infinity;
        for (const entry of this.#entries.values()) {
            if (entry.item.status !== "ready" || entry.parts.length === 0 || !eligible(entry)) continue;
            const score = decayed(entry.item.score, entry.item.at, now);
            if (score > bestScore || (score === bestScore && best && entry.item.at < best.item.at)) {
                best = entry;
                bestScore = score;
            }
        }
        return best;
    }

    /** Skip unspoken entries past their deadline. Returns how many expired. */
    expire(now: number): number {
        let n = 0;
        for (const entry of this.#entries.values()) {
            const status = entry.item.status;
            if (entry.expiresAt !== undefined && now > entry.expiresAt && (status === "pending" || status === "ready")) {
                entry.item = { ...entry.item, status: "skipped" };
                entry.parts = [];
                n += 1;
            }
        }
        if (n > 0) {
            this.#trim();
            this.changed();
        }
        return n;
    }

    snapshot(): ReplyItem[] {
        return [...this.#entries.values()].map((entry) => entry.item).sort((a, b) => b.at - a.at);
    }

    /** Schedule a coalesced broadcast. */
    changed(): void {
        if (this.#timer) return;
        const wait = Math.max(0, this.#lastEmit + EMIT_INTERVAL_MS - Date.now());
        this.#timer = setTimeout(() => {
            this.#timer = null;
            this.#lastEmit = Date.now();
            this.#onChange(this.snapshot());
        }, wait);
    }

    dispose(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
    }

    #lowestPending(now: number): QueueEntry | undefined {
        let worst: QueueEntry | undefined;
        let worstScore = Infinity;
        for (const entry of this.#entries.values()) {
            if (entry.item.status !== "pending") continue;
            const score = decayed(entry.item.score, entry.item.at, now);
            if (score < worstScore) {
                worst = entry;
                worstScore = score;
            }
        }
        return worst;
    }

    /** Drop the oldest finished entries beyond the history budget. */
    #trim(): void {
        const finished = [...this.#entries.values()]
            .filter((entry) => !isActive(entry.item.status))
            .sort((a, b) => b.item.at - a.item.at);
        for (const entry of finished.slice(KEEP_FINISHED)) this.#entries.delete(entry.item.id);
    }
}
