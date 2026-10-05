import { describe, expect, it, vi } from "vitest";

import { CodaiClient } from "./client.js";
import { SentenceSplitter, clampSentences, splitSentences } from "./sentences.js";
import { SseParser, chatDelta } from "./sse.js";

function chunk(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** A recorded-style codai stream, split at awkward byte boundaries. */
const STREAM_FIXTURE = [
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    chunk("Salut, Ana"),
    chunk("! Mă bucur"),
    chunk(" că ești aici. Ce"),
    chunk(" mai faci?"),
    "data: [DONE]\n\n",
].join("");

function splitAt(text: string, sizes: number[]): string[] {
    const out: string[] = [];
    let i = 0;
    for (const size of sizes) {
        out.push(text.slice(i, i + size));
        i += size;
    }
    if (i < text.length) out.push(text.slice(i));
    return out;
}

describe("SseParser", () => {
    it("reassembles frames split mid-line and mid-field", () => {
        const parser = new SseParser();
        const payloads = splitAt(STREAM_FIXTURE, [3, 7, 1, 40, 2, 19, 5]).flatMap((part) => parser.push(part));
        payloads.push(...parser.end());
        const text = payloads.map(chatDelta).filter((d) => d !== null).join("");
        expect(text).toBe("Salut, Ana! Mă bucur că ești aici. Ce mai faci?");
        expect(payloads.at(-1)).toBe("[DONE]");
    });

    it("handles CRLF, comments, missing space and multi-line data", () => {
        const parser = new SseParser();
        const out = parser.push(": ping\r\ndata:one\r\ndata: two\r\n\r\nevent: x\ndata: three\n\n");
        expect(out).toEqual(["one\ntwo", "three"]);
    });

    it("does not split a CRLF that straddles two chunks", () => {
        const parser = new SseParser();
        expect(parser.push("data: a\r")).toEqual([]);
        expect(parser.push("\ndata: b\r\n\r\n")).toEqual(["a\nb"]);
    });

    it("flushes a final event without a trailing blank line", () => {
        const parser = new SseParser();
        expect(parser.push("data: tail")).toEqual([]);
        expect(parser.end()).toEqual(["tail"]);
    });

    it("chatDelta ignores [DONE], role frames and garbage", () => {
        expect(chatDelta("[DONE]")).toBeNull();
        expect(chatDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toBeNull();
        expect(chatDelta("not json")).toBeNull();
        expect(chatDelta('{"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
    });
});

describe("SentenceSplitter", () => {
    it("releases a sentence as soon as its boundary is certain", () => {
        const splitter = new SentenceSplitter();
        expect(splitter.push("Salut, Ana")).toEqual([]);
        expect(splitter.push("! Mă")).toEqual(["Salut, Ana!"]);
        expect(splitter.push(" bucur.")).toEqual([]);
        expect(splitter.push(" Ce faci?")).toEqual(["Mă bucur."]);
        expect(splitter.flush()).toBe("Ce faci?");
        expect(splitter.flush()).toBeNull();
    });

    it("keeps decimals, domains and abbreviations intact", () => {
        expect(splitSentences("Costă 3.5 lei pe ai.codai.ro azi. Dl. Popescu a zis da!")).toEqual([
            "Costă 3.5 lei pe ai.codai.ro azi.",
            "Dl. Popescu a zis da!",
        ]);
    });

    it("treats ?!, ellipsis and closing quotes as one boundary", () => {
        expect(splitSentences('Serios?! Wow… "Chiar așa." Da')).toEqual(["Serios?!", "Wow…", '"Chiar așa."', "Da"]);
    });

    it("clampSentences keeps the first N", () => {
        expect(clampSentences("Unu. Doi. Trei.", 2)).toBe("Unu. Doi.");
    });
});

function sseResponse(text: string, status = 200): Response {
    const bytes = new TextEncoder().encode(text);
    const parts = [bytes.slice(0, 50), bytes.slice(50, 51), bytes.slice(51)];
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        },
    });
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function client(fetchImpl: typeof fetch, key: string | null = "sk-test", onUnauthorized = vi.fn()) {
    return new CodaiClient({ baseUrl: () => "https://ai.codai.ro/", apiKey: async () => key, fetch: fetchImpl, onUnauthorized });
}

describe("CodaiClient", () => {
    it("streams sentences and reports first-sentence latency", async () => {
        const fetchImpl = vi.fn(async () => sseResponse(STREAM_FIXTURE));
        const sentences: string[] = [];
        const result = await client(fetchImpl).streamChat({
            model: "codai-fast",
            messages: [{ role: "user", content: "hi" }],
            onSentence: (s) => sentences.push(s),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(sentences).toEqual(["Salut, Ana!", "Mă bucur că ești aici.", "Ce mai faci?"]);
        expect(result.value.firstSentenceMs).not.toBeNull();
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://ai.codai.ro/v1/chat/completions");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
        expect(JSON.parse(String(init.body))).toMatchObject({ model: "codai-fast", stream: true });
    });

    it("returns typed errors instead of throwing", async () => {
        const onUnauthorized = vi.fn();
        const unauthorized = await client(
            async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
            "sk",
            onUnauthorized,
        ).mintLiveToken();
        expect(unauthorized).toEqual({ ok: false, error: expect.objectContaining({ kind: "unauthorized", message: "bad key" }) });
        expect(onUnauthorized).toHaveBeenCalledOnce();

        const limited = await client(async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } })).mintLiveToken();
        expect(limited).toEqual({ ok: false, error: expect.objectContaining({ kind: "rate_limited", retryAfterMs: 2000 }) });

        const server = await client(async () => new Response("oops", { status: 502 })).mintLiveToken();
        expect(server).toEqual({ ok: false, error: expect.objectContaining({ kind: "server", status: 502 }) });

        const network = await client(async () => Promise.reject(new TypeError("fetch failed"))).mintLiveToken();
        expect(network).toEqual({ ok: false, error: expect.objectContaining({ kind: "network" }) });

        const fetchImpl = vi.fn(async () => new Response("{}"));
        const noKey = await client(fetchImpl, null).mintLiveToken();
        expect(noKey).toEqual({ ok: false, error: expect.objectContaining({ kind: "no_key" }) });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("mints a live token and normalises an ISO expiry", async () => {
        const fetchImpl = vi.fn(async () => Response.json({ token: "eph_abc", expires_at: "2026-10-05T10:00:00.000Z", scope: "live" }));
        const result = await client(fetchImpl).mintLiveToken();
        expect(result).toEqual({ ok: true, value: { token: "eph_abc", expiresAt: Date.parse("2026-10-05T10:00:00.000Z") } });
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ scope: "live", ttl_seconds: 600 });
    });

    it("parses a System One batch response", async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({
                model: "codai-s1",
                items: [{ id: "e1", answers: { is_question: { type: "noul", noul: 0.9 } } }, { bogus: true }],
                fallback_used: true,
                latency_ms: 120,
            }),
        );
        const result = await client(fetchImpl).systemOne({
            items: [{ id: "e1", state: "ce faci?" }],
            questions: { is_question: { type: "noul", instructions: "Is it a question?" } },
        });
        expect(result).toEqual({
            ok: true,
            value: { model: "codai-s1", items: [{ id: "e1", answers: { is_question: { type: "noul", noul: 0.9 } } }], fallbackUsed: true, latencyMs: 120 },
        });
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toMatchObject({ timeout_ms: 800, fallback: "codai-fast" });
    });
});
