/**
 * The shared blackboard every pet agent reads (decision Q54): one append-only,
 * time-ordered log of what happened on the stream — chat, gifts, follows, what
 * the streamer said, what the co-host said, what each pet said, and what the
 * owner did to the pets. Agents keep their own private session elsewhere.
 *
 * Viewer text is stored already sanitised and is always rendered as quoted
 * data. The log is bounded in time and size; older entries roll into a
 * counts-only digest so a long stream never grows the prompt.
 */

export type LogKind = "chat" | "gift" | "follow" | "streamer" | "cohost" | "pet" | "owner";

export interface LogEntry {
    at: number;
    kind: LogKind;
    /** Viewer nickname (sanitised) or pet id; absent for streamer/co-host/owner. */
    who?: string;
    text: string;
}

export const LOG_WINDOW_MS = 120_000;
const MAX_ENTRIES = 300;

interface Digest {
    chats: number;
    gifts: number;
    follows: number;
    petLines: number;
    since: number;
}

export class StreamLog {
    #entries: LogEntry[] = [];
    #digest: Digest = { chats: 0, gifts: 0, follows: 0, petLines: 0, since: 0 };

    add(entry: LogEntry): void {
        if (entry.text.trim() === "") return;
        if (this.#digest.since === 0) this.#digest.since = entry.at;
        this.#entries.push(entry);
        this.#trim(entry.at);
    }

    /** Entries newer than `now - windowMs`, oldest first, at most `max` (newest kept). */
    recent(now: number, windowMs = LOG_WINDOW_MS, max = 24, kinds?: ReadonlySet<LogKind>): LogEntry[] {
        this.#trim(now);
        const out = this.#entries.filter((e) => now - e.at <= windowMs && (!kinds || kinds.has(e.kind)));
        return out.slice(-max);
    }

    /** Last `n` lines spoken by pets (any pet, or excluding `except`). */
    petLines(n: number, except?: string): LogEntry[] {
        return this.#entries.filter((e) => e.kind === "pet" && e.who !== except).slice(-n);
    }

    /** One line about everything that rolled out of the window (counts only). */
    digest(): string {
        const d = this.#digest;
        if (d.chats + d.gifts + d.follows + d.petLines === 0) return "";
        return `earlier this stream: ${d.chats} chat messages, ${d.gifts} gifts, ${d.follows} follows, ${d.petLines} pet lines`;
    }

    #trim(now: number): void {
        while (this.#entries.length > 0) {
            const first = this.#entries[0];
            if (!first || (now - first.at <= LOG_WINDOW_MS * 2 && this.#entries.length <= MAX_ENTRIES)) break;
            this.#entries.shift();
            if (first.kind === "chat") this.#digest.chats += 1;
            else if (first.kind === "gift") this.#digest.gifts += 1;
            else if (first.kind === "follow") this.#digest.follows += 1;
            else if (first.kind === "pet") this.#digest.petLines += 1;
        }
    }

    clear(): void {
        this.#entries = [];
        this.#digest = { chats: 0, gifts: 0, follows: 0, petLines: 0, since: 0 };
    }
}

/** Render entries as compact data lines for a prompt (viewer text quoted, never instructions). */
export function renderLog(entries: readonly LogEntry[], now: number, self?: string): string[] {
    return entries.map((e) => {
        const ago = `${Math.max(0, Math.round((now - e.at) / 1000))}s ago`;
        switch (e.kind) {
            case "chat":
                return `${ago} viewer ${e.who ?? "someone"} wrote: «${e.text}»`;
            case "gift":
            case "follow":
                return `${ago} ${e.text}`;
            case "streamer":
                return `${ago} the streamer said: «${e.text}»`;
            case "cohost":
                return `${ago} the co-host said: "${e.text}"`;
            case "pet":
                return `${ago} ${e.who === self ? "you" : e.who} said: "${e.text}"`;
            case "owner":
                return `${ago} ${e.text}`;
        }
    });
}
