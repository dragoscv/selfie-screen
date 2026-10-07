import { sidecarClient } from "../sidecar-client.js";
import { subscribeMicFeed } from "./mic-feed.js";

/** One caption line: the original sentence and (when translation is on) its translation. */
export interface CaptionLine {
    key: string;
    text: string;
    translated?: string;
    at: number;
}

export interface CaptionSnapshot {
    lines: readonly CaptionLine[];
    /** Words of the sentence being spoken now (not final yet). */
    partial: string;
    state: "off" | "live" | "offline";
}

/** A line stays this long after it was said, then the strip collapses. */
export const LINE_TTL_MS = 8_000;
const EMPTY: CaptionSnapshot = { lines: [], partial: "", state: "off" };

/**
 * The live transcript, shared by the preview captions (DOM) and the output caption layer
 * (canvas in the video): final lines from the main window's mic (`mic://diag`), their
 * translations from the sidecar (`transcriptTranslation`, same STT item id), the current
 * partial and the connection state. Lines expire after LINE_TTL_MS.
 */
export class CaptionFeed {
    #snap: CaptionSnapshot = EMPTY;
    #keep: number;
    readonly #subs = new Set<(s: CaptionSnapshot) => void>();
    readonly #pending = new Map<string, string>();
    #stop: (() => void) | null = null;
    #timer = 0;

    constructor(keep = 2) {
        this.#keep = keep;
    }

    set keep(n: number) {
        this.#keep = Math.max(1, n);
        if (this.#snap.lines.length > this.#keep) this.#set({ ...this.#snap, lines: this.#snap.lines.slice(-this.#keep) });
    }

    get snapshot(): CaptionSnapshot {
        return this.#snap;
    }

    subscribe(cb: (s: CaptionSnapshot) => void): () => void {
        this.#subs.add(cb);
        if (this.#subs.size === 1) this.#start();
        cb(this.#snap);
        return () => {
            this.#subs.delete(cb);
            if (this.#subs.size === 0) this.#end();
        };
    }

    #start(): void {
        const offMic = subscribeMicFeed((p) => {
            const d = p.diag;
            const state: CaptionSnapshot["state"] = !p.enabled ? "off" : d?.ws === "open" ? "live" : "offline";
            let lines = this.#snap.lines;
            const finals = p.events.filter((e) => e.kind === "final");
            if (finals.length > 0) {
                const added = finals.map((f, i) => {
                    const key = f.itemId ?? `${f.at}-${i}`;
                    const translated = this.#pending.get(key);
                    if (translated !== undefined) this.#pending.delete(key);
                    return { key, text: f.text, at: f.at, ...(translated ? { translated } : {}) };
                });
                lines = [...lines.filter((l) => !added.some((a) => a.key === l.key)), ...added].slice(-this.#keep);
            }
            const partial = d?.partial ?? "";
            if (lines !== this.#snap.lines || partial !== this.#snap.partial || state !== this.#snap.state) this.#set({ lines, partial, state });
        });
        const offSidecar = sidecarClient.onMessage((m) => {
            if (m.type !== "transcriptTranslation") return;
            const i = this.#snap.lines.findIndex((l) => l.key === m.itemId);
            if (i < 0) {
                // Translation can beat the mic's 10 Hz diag tick: hold it for the line.
                this.#pending.set(m.itemId, m.text);
                if (this.#pending.size > 20) this.#pending.delete(this.#pending.keys().next().value ?? "");
                return;
            }
            const lines = this.#snap.lines.map((l, j) => (j === i ? { ...l, translated: m.text } : l));
            this.#set({ ...this.#snap, lines });
        });
        this.#stop = () => {
            offMic();
            offSidecar();
        };
    }

    #end(): void {
        this.#stop?.();
        this.#stop = null;
        window.clearTimeout(this.#timer);
    }

    #set(next: CaptionSnapshot): void {
        this.#snap = next;
        for (const cb of this.#subs) cb(next);
        this.#scheduleExpiry();
    }

    #scheduleExpiry(): void {
        window.clearTimeout(this.#timer);
        const lines = this.#snap.lines;
        if (lines.length === 0) return;
        const oldest = Math.min(...lines.map((l) => l.at));
        this.#timer = window.setTimeout(
            () => {
                const now = Date.now();
                const kept = this.#snap.lines.filter((l) => now - l.at < LINE_TTL_MS);
                if (kept.length !== this.#snap.lines.length) this.#set({ ...this.#snap, lines: kept });
            },
            Math.max(200, oldest + LINE_TTL_MS - Date.now()),
        );
    }
}

/** One feed per studio window (preview captions + output layer share it). */
export const captionFeed = new CaptionFeed();
