export interface SseEvent {
    event: string;
    data: string;
}

export interface SseParser {
    feed(chunk: string): void;
    /** Emit a final event that was not followed by a blank line. */
    flush(): void;
}

/**
 * Minimal `text/event-stream` parser (WHATWG framing: blocks separated by a
 * blank line, `event:` and `data:` fields, `:` comments). Chunks may split a
 * block — or a CRLF — anywhere.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
    let buffer = "";

    const emit = (block: string) => {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
            if (line === "" || line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") event = value;
            else if (field === "data") data.push(value);
        }
        if (data.length > 0) onEvent({ event, data: data.join("\n") });
    };

    return {
        feed(chunk) {
            buffer = (buffer + chunk).replace(/\r\n?/g, (match, offset: number, whole: string) =>
                // A lone trailing CR may be the first half of a CRLF in the next chunk.
                match === "\r" && offset === whole.length - 1 ? "\r" : "\n",
            );
            let index = buffer.indexOf("\n\n");
            while (index !== -1) {
                emit(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
                index = buffer.indexOf("\n\n");
            }
        },
        flush() {
            const rest = buffer.replace(/\r$/, "").trim();
            buffer = "";
            if (rest !== "") emit(rest);
        },
    };
}
