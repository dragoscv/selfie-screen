/**
 * Rolling window of what the streamer said, fed by the renderer's realtime
 * STT session. Final segments are kept for `windowMs`; the latest partial is
 * appended so the responder sees what is being said right now.
 */
export class TranscriptWindow {
    #finals: Array<{ id: string; text: string; at: number }> = [];
    #partial: { id: string; text: string; at: number } | null = null;
    #windowMs: number;
    lastAt = 0;

    constructor(windowMs = 60_000) {
        this.#windowMs = windowMs;
    }

    push(itemId: string, text: string, final: boolean, at: number): void {
        this.lastAt = Math.max(this.lastAt, at);
        const clean = text.trim();
        if (final) {
            if (this.#partial?.id === itemId) this.#partial = null;
            if (clean !== "") {
                const existing = this.#finals.findIndex((s) => s.id === itemId);
                if (existing === -1) this.#finals.push({ id: itemId, text: clean, at });
                else this.#finals[existing] = { id: itemId, text: clean, at };
            }
        } else {
            this.#partial = clean === "" ? null : { id: itemId, text: clean, at };
        }
        this.#prune(at);
    }

    #prune(now: number): void {
        while (this.#finals.length > 0 && now - (this.#finals[0]?.at ?? now) > this.#windowMs) this.#finals.shift();
    }

    text(now: number, maxChars = 1500): string {
        this.#prune(now);
        const parts = this.#finals.map((s) => s.text);
        if (this.#partial && now - this.#partial.at <= this.#windowMs) parts.push(this.#partial.text);
        const joined = parts.join(" ");
        return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
    }
}
