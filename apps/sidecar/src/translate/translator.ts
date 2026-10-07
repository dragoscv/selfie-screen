import type { CodaiClient } from "../codai/client.js";
import { detectLanguage } from "./detect.js";

/**
 * Live chat translation into Romanian (WS20-14).
 *
 * Only lines the deterministic detector flags as foreign are sent; they are
 * batched (one codai-fast call per window), cached by normalised text, and
 * bounded by a timeout. Any failure is a silent no-op — the feed never waits
 * for a translation, it simply arrives later as a separate frame.
 */

export const BATCH_WINDOW_MS = 400;
export const MAX_BATCH = 12;
const MAX_PENDING = 60;
const CACHE_SIZE = 500;
const TIMEOUT_MS = 4_000;

const SYSTEM = [
    "Traduci mesaje scurte dintr-un chat de TikTok LIVE în limba română, natural și concis.",
    "Păstrează emoji, nume și @mențiuni. Nu adăuga explicații.",
    'Răspunde DOAR cu JSON: {"<id>": "traducere", ...}. Dacă un mesaj este deja în română, omite-l.',
].join("\n");

/** Prompt for live captions: everything the streamer says, into `target` (BCP-47 code). */
export function captionPrompt(target: string): string {
    return [
        `You translate a TikTok LIVE streamer's spoken sentences (live subtitles) into the language with BCP-47 code "${target}".`,
        "Natural, short, spoken style; keep names, emoji and @mentions; no explanations, no quotes.",
        'Reply ONLY with JSON: {"<id>": "translation", ...}. Translate every line, even short ones.',
    ].join("\n");
}

export interface TranslatorOptions {
    /** "foreign" = chat: only lines the detector flags as not Romanian; "all" = every line (captions). */
    filter?: "foreign" | "all";
    /** Batch window (ms): captions want low latency. */
    windowMs?: number;
}

export interface TranslationJob {
    eventId: string;
    text: string;
}

export interface TranslatorDeps {
    client: Pick<CodaiClient, "complete">;
    model: () => string;
    emit: (eventId: string, lang: string, text: string) => void;
    onError?: (message: string) => void;
}

interface Pending extends TranslationJob {
    key: string;
    lang: string;
}

/** Parse `{ "<id>": "text" }` from a model reply, keeping only known ids. */
export function parseTranslations(raw: string, allowed: ReadonlySet<string>): Map<string, string> {
    const out = new Map<string, string>();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!allowed.has(id) || typeof value !== "string") continue;
        const text = value.trim().slice(0, 500);
        if (text !== "") out.set(id, text);
    }
    return out;
}

function cacheKey(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export class Translator {
    #deps: TranslatorDeps;
    readonly #filter: "foreign" | "all";
    readonly #windowMs: number;
    #system = SYSTEM;
    #target = "ro";
    #cache = new Map<string, string>();
    #pending: Pending[] = [];
    #timer: NodeJS.Timeout | null = null;
    #busy = false;
    enabled = false;
    minLetters = 6;

    constructor(deps: TranslatorDeps, options: TranslatorOptions = {}) {
        this.#deps = deps;
        this.#filter = options.filter ?? "foreign";
        this.#windowMs = options.windowMs ?? BATCH_WINDOW_MS;
    }

    /** Captions: change the target language (prompt + cache are per target). */
    set target(lang: string) {
        if (lang === this.#target) return;
        this.#target = lang;
        this.#system = captionPrompt(lang);
        this.#cache.clear();
        this.#pending = [];
    }

    get target(): string {
        return this.#target;
    }

    /** Returns true when the line was queued or answered from cache. */
    offer(job: TranslationJob): boolean {
        if (!this.enabled) return false;
        if (job.text.trim() === "") return false;
        const detection = this.#filter === "all" ? { lang: this.#target, foreign: true } : detectLanguage(job.text, this.minLetters);
        if (!detection.foreign) return false;
        const key = cacheKey(job.text);
        const cached = this.#cache.get(key);
        if (cached !== undefined) {
            // Refresh LRU position.
            this.#cache.delete(key);
            this.#cache.set(key, cached);
            if (cached !== "") this.#deps.emit(job.eventId, detection.lang, cached);
            return true;
        }
        this.#pending.push({ ...job, key, lang: detection.lang });
        if (this.#pending.length > MAX_PENDING) this.#pending.splice(0, this.#pending.length - MAX_PENDING);
        this.#schedule();
        return true;
    }

    async flush(): Promise<number> {
        if (this.#busy || this.#pending.length === 0) return 0;
        this.#busy = true;
        const batch = this.#pending.splice(0, MAX_BATCH);
        let emitted = 0;
        try {
            const ids = new Map(batch.map((job, i) => [`m${i}`, job] as const));
            const lines = [...ids].map(([id, job]) => `${id}: ${job.text.replace(/\s+/g, " ").slice(0, 300)}`);
            const result = await this.#deps.client.complete(
                this.#deps.model(),
                [
                    { role: "system", content: this.#system },
                    { role: "user", content: lines.join("\n") },
                ],
                TIMEOUT_MS,
                60 + batch.length * 60,
            );
            if (!result.ok) {
                this.#deps.onError?.(`${result.error.kind}: ${result.error.message}`);
                return 0;
            }
            const translations = parseTranslations(result.value, new Set(ids.keys()));
            for (const [id, job] of ids) {
                const text = translations.get(id) ?? "";
                // Cache misses too ("" = model said it is Romanian), so they never cost twice.
                this.#remember(job.key, text);
                if (text !== "" && (this.#filter === "all" || cacheKey(text) !== job.key)) {
                    this.#deps.emit(job.eventId, job.lang, text);
                    emitted += 1;
                }
            }
            return emitted;
        } finally {
            this.#busy = false;
            if (this.#pending.length > 0) this.#schedule();
        }
    }

    dispose(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#pending = [];
    }

    #remember(key: string, text: string): void {
        this.#cache.set(key, text);
        if (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value ?? "");
    }

    #schedule(): void {
        if (this.#timer) return;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            void this.flush();
        }, this.#windowMs);
        this.#timer.unref();
    }
}
