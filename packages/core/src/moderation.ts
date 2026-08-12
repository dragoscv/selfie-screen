import type { ChatEvent } from "./events.js";

/**
 * Normalise text for matching: lowercase, strip diacritics, and fold the
 * common leetspeak substitutions spammers use to slip past word lists.
 * Romanian diacritics (ăâîșț) fold to their ASCII base so a single blocklist
 * entry covers both spellings.
 */
export function normaliseForMatch(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[0]/g, "o")
        .replace(/[1!|]/g, "i")
        .replace(/[3]/g, "e")
        .replace(/[4@]/g, "a")
        .replace(/[5$]/g, "s")
        .replace(/[7]/g, "t");
}

/** Escape a user-supplied word so it can be embedded in a RegExp safely. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a word list into one regex. Entries are matched on word boundaries
 * so `ass` does not flag `password`; wrap an entry in `*` (e.g. `*spam*`) to
 * opt into substring matching.
 */
export function compileWordList(words: readonly string[]): RegExp | null {
    const patterns = words
        .map((word) => word.trim())
        .filter((word) => word.length > 0)
        .map((word) => {
            const substring = word.startsWith("*") && word.endsWith("*") && word.length > 2;
            const bare = substring ? word.slice(1, -1) : word;
            const escaped = escapeRegExp(normaliseForMatch(bare));
            return substring ? escaped : `\\b${escaped}\\b`;
        });

    if (patterns.length === 0) return null;
    return new RegExp(patterns.join("|"), "iu");
}

export interface ModerationRules {
    blockedWords: readonly string[];
    blockedUsers: readonly string[];
    alertKeywords: readonly string[];
    hideSpam: boolean;
    spamWindowMs: number;
}

export interface ModerationVerdict {
    /** Hide the event from every surface. */
    blocked: boolean;
    /** Why it was blocked, for the moderation log. */
    reason?: "word" | "user" | "spam";
    /** The event matched an alert keyword. */
    alert: boolean;
}

/**
 * Stateful moderator. Spam detection needs memory of recent messages, so this
 * is a class rather than a pure function — but the matching itself is pure and
 * the compiled regexes are cached until the rules change.
 */
export class Moderator {
    #rules: ModerationRules;
    #blockedRe: RegExp | null = null;
    #alertRe: RegExp | null = null;
    #blockedUsers = new Set<string>();
    /** `user\u0000normalisedText` → last-seen epoch ms. */
    #recent = new Map<string, number>();

    constructor(rules: ModerationRules) {
        this.#rules = rules;
        this.#recompile();
    }

    setRules(rules: ModerationRules): void {
        this.#rules = rules;
        this.#recompile();
    }

    #recompile(): void {
        this.#blockedRe = compileWordList(this.#rules.blockedWords);
        this.#alertRe = compileWordList(this.#rules.alertKeywords);
        this.#blockedUsers = new Set(
            this.#rules.blockedUsers.map((u) => u.trim().replace(/^@/, "").toLowerCase()),
        );
    }

    /** Drop spam-window entries that can no longer match. */
    #prune(now: number): void {
        if (this.#recent.size < 512) return;
        for (const [key, at] of this.#recent) {
            if (now - at > this.#rules.spamWindowMs) this.#recent.delete(key);
        }
    }

    evaluate(event: ChatEvent): ModerationVerdict {
        const handle = event.user.uniqueId.toLowerCase();
        if (this.#blockedUsers.has(handle)) {
            return { blocked: true, reason: "user", alert: false };
        }

        const normalised = normaliseForMatch(event.text);

        if (this.#blockedRe?.test(normalised)) {
            return { blocked: true, reason: "word", alert: false };
        }

        // Only chat can be spam; a viewer legitimately sends the same gift twice.
        if (this.#rules.hideSpam && event.kind === "chat" && normalised.length > 0) {
            const key = `${handle}\u0000${normalised}`;
            const last = this.#recent.get(key);
            this.#recent.set(key, event.at);
            this.#prune(event.at);
            if (last !== undefined && event.at - last < this.#rules.spamWindowMs) {
                return { blocked: true, reason: "spam", alert: false };
            }
        }

        return { blocked: false, alert: this.#alertRe?.test(normalised) ?? false };
    }

    reset(): void {
        this.#recent.clear();
    }
}
