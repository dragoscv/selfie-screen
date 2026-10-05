import type { CodaiClient } from "../codai/client.js";

/**
 * Durable-fact extraction for viewer memory. Messages from viewers the
 * co-host engaged with are buffered and sent to codai-fast in ONE call every
 * 30 s; the model returns `{ "<uniqueId>": ["fact", ...] }` with only stable
 * self-statements (city, job, pet, hobby, birthday) — never moods or opinions.
 */

export const FACTS_INTERVAL_MS = 30_000;
const MAX_BATCH = 30;

const SYSTEM = [
    "Extragi fapte durabile pe care spectatorii le spun DESPRE EI ÎNȘIȘI într-un chat de live.",
    "Exemple: orașul, meseria, animalul de companie, hobby-ul, ziua de naștere, limba vorbită.",
    "Ignoră stări de moment, opinii, întrebări, glume, lucruri despre alții.",
    'Răspunde DOAR cu JSON: {"<uniqueId>": ["fapt scurt la persoana a treia", ...]}. Fără fapte => {}.',
].join("\n");

export interface FactMessage {
    uniqueId: string;
    nickname: string;
    text: string;
}

/** Find and parse the first JSON object in a model reply. */
export function parseFacts(raw: string, allowed: ReadonlySet<string>): Map<string, string[]> {
    const out = new Map<string, string[]>();
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
        if (!allowed.has(id) || !Array.isArray(value)) continue;
        const facts = value.filter((f): f is string => typeof f === "string" && f.trim().length > 2).map((f) => f.trim().slice(0, 200));
        if (facts.length > 0) out.set(id, facts.slice(0, 5));
    }
    return out;
}

export interface FactCollectorDeps {
    client: Pick<CodaiClient, "complete">;
    model: () => string;
    store: (uniqueId: string, facts: string[]) => void;
}

export class FactCollector {
    #deps: FactCollectorDeps;
    #buffer: FactMessage[] = [];
    #timer: NodeJS.Timeout | null = null;
    #busy = false;

    constructor(deps: FactCollectorDeps) {
        this.#deps = deps;
    }

    add(message: FactMessage): void {
        if (message.text.trim().length < 8) return;
        this.#buffer.push(message);
        if (this.#buffer.length > MAX_BATCH) this.#buffer.splice(0, this.#buffer.length - MAX_BATCH);
        if (!this.#timer) {
            this.#timer = setTimeout(() => {
                this.#timer = null;
                void this.flush();
            }, FACTS_INTERVAL_MS);
            this.#timer.unref();
        }
    }

    async flush(): Promise<number> {
        if (this.#busy || this.#buffer.length === 0) return 0;
        this.#busy = true;
        const batch = this.#buffer;
        this.#buffer = [];
        try {
            const lines = batch.map((m) => `${m.uniqueId} (${m.nickname}): ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
            const result = await this.#deps.client.complete(
                this.#deps.model(),
                [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: lines.join("\n") },
                ],
                10_000,
                400,
            );
            if (!result.ok) return 0;
            const facts = parseFacts(result.value, new Set(batch.map((m) => m.uniqueId)));
            for (const [id, list] of facts) this.#deps.store(id, list);
            return facts.size;
        } finally {
            this.#busy = false;
        }
    }

    dispose(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
    }
}
