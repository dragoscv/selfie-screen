/**
 * Incremental Server-Sent Events parser for OpenAI-style streams.
 *
 * Feed it arbitrary byte-chunk boundaries (a frame may be split mid-line or
 * mid-UTF-8 sequence upstream; decoding happens before this) and it yields
 * complete `data:` payloads. Comments (`: keep-alive`) and other fields are
 * ignored; multi-line data is joined with `\n` per the spec.
 */
export class SseParser {
    #buffer = "";
    #data: string[] = [];

    push(chunk: string): string[] {
        this.#buffer += chunk;
        const out: string[] = [];
        let index: number;
        while ((index = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
            // A lone trailing CR may be the first half of a CRLF split across chunks.
            if (index === this.#buffer.length - 1 && this.#buffer.endsWith("\r")) break;
            const line = this.#buffer.slice(0, index);
            const newline = this.#buffer.startsWith("\r\n", index) ? 2 : 1;
            this.#buffer = this.#buffer.slice(index + newline);
            this.#line(line, out);
        }
        return out;
    }

    /** Flush a trailing event that was not followed by a blank line. */
    end(): string[] {
        const out: string[] = [];
        if (this.#buffer !== "") this.#line(this.#buffer.replace(/\r$/, ""), out);
        this.#buffer = "";
        this.#line("", out);
        return out;
    }

    #line(line: string, out: string[]): void {
        if (line === "") {
            if (this.#data.length > 0) out.push(this.#data.join("\n"));
            this.#data = [];
            return;
        }
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== "data") return;
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        this.#data.push(value);
    }
}

/** Pull the text delta out of one chat-completions chunk; `null` for non-content frames. */
export function chatDelta(payload: string): string | null {
    if (payload === "[DONE]") return null;
    try {
        const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
        };
        const content = parsed.choices?.[0]?.delta?.content;
        return typeof content === "string" && content !== "" ? content : null;
    } catch {
        return null;
    }
}
