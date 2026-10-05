/**
 * Streaming sentence splitter: text arrives token by token and complete
 * sentences are released as soon as their boundary is certain, so TTS can
 * start on the first sentence while the model is still writing the second.
 *
 * A boundary is `.`, `!`, `?` or `…` (runs like `?!` or `...` included),
 * optionally followed by closing quotes/brackets, then whitespace. The
 * whitespace requirement is what keeps `3.5`, `ai.codai.ro` and `e.g.x`
 * intact. Common abbreviations (`dl.`, `Dr.`, `etc.`) are not boundaries.
 */

const ABBREVIATIONS = new Set([
    "dl", "dna", "dra", "dr", "prof", "ing", "nr", "str", "etc", "ex", "vs", "mr", "mrs", "ms", "st", "jr", "sr", "e.g", "i.e",
]);

const BOUNDARY = /[.!?…]+["'”’»)\]]*\s+/g;

export class SentenceSplitter {
    #buffer = "";

    /** Add streamed text; returns every sentence completed by it. */
    push(text: string): string[] {
        this.#buffer += text;
        const out: string[] = [];
        let start = 0;
        BOUNDARY.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = BOUNDARY.exec(this.#buffer)) !== null) {
            const end = match.index + match[0].length;
            const candidate = this.#buffer.slice(start, end).trim();
            if (isAbbreviation(candidate)) continue;
            if (candidate !== "") out.push(candidate);
            start = end;
        }
        this.#buffer = this.#buffer.slice(start);
        return out;
    }

    /** Whatever is left once the stream ends. */
    flush(): string | null {
        const rest = this.#buffer.trim();
        this.#buffer = "";
        return rest === "" ? null : rest;
    }
}

function isAbbreviation(sentence: string): boolean {
    if (!sentence.endsWith(".")) return false;
    const lastWord = sentence.slice(0, -1).split(/\s+/).pop() ?? "";
    return ABBREVIATIONS.has(lastWord.toLowerCase());
}

/** Split complete text into sentences (non-streaming convenience). */
export function splitSentences(text: string): string[] {
    const splitter = new SentenceSplitter();
    const out = splitter.push(text);
    const rest = splitter.flush();
    if (rest) out.push(rest);
    return out;
}

/** Keep at most `max` sentences — the persona contract is "two short sentences". */
export function clampSentences(text: string, max: number): string {
    return splitSentences(text).slice(0, max).join(" ");
}
