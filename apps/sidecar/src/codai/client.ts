import { err, ok, type Result } from "../result.js";
import { SentenceSplitter } from "./sentences.js";
import { SseParser, chatDelta } from "./sse.js";

/**
 * Thin fetch-based client for the codai gateway (ai.codai.ro).
 *
 * Every expected failure (no key, 401, 429, 5xx, timeout, network) comes back
 * as a typed `Result` error — callers on the live hot path must degrade, not
 * crash. The API key is read lazily per call and never logged.
 */

export type CodaiErrorKind =
    | "no_key"
    | "unauthorized"
    | "rate_limited"
    | "bad_request"
    | "unavailable"
    | "server"
    | "timeout"
    | "network"
    | "invalid_response"
    | "aborted";

export interface CodaiError {
    kind: CodaiErrorKind;
    status?: number;
    message: string;
    /** From `retry-after` on 429/503, in ms. */
    retryAfterMs?: number;
}

export interface CodaiClientOptions {
    baseUrl: () => string;
    apiKey: () => Promise<string | null>;
    fetch?: typeof fetch;
    /** Called on 401 so the key cache can be dropped (rotated key). */
    onUnauthorized?: () => void;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface StreamChatRequest {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    /** Overall budget for the whole stream. */
    timeoutMs?: number;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onSentence?: (sentence: string, index: number) => void;
}

export interface StreamChatResult {
    text: string;
    sentences: string[];
    /** ms from request start to the first complete sentence; null if none. */
    firstSentenceMs: number | null;
    totalMs: number;
}

export interface LiveToken {
    token: string;
    expiresAt: number;
}

export type S1Question =
    | { type: "noul"; instructions: string }
    | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export type S1Answer =
    | { type: "noul"; noul: number }
    | { type: "choice"; choice: string; confidence: number; probabilities?: Record<string, number> }
    | { type: "score"; score: number; confidence: number };

export interface S1BatchRequest {
    items: Array<{ id: string; state: string | Record<string, unknown> }>;
    questions: Record<string, S1Question>;
    timeoutMs?: number;
    fallback?: "none" | "codai-fast";
}

export interface S1BatchResult {
    model: string;
    items: Array<{ id: string; answers: Record<string, S1Answer> }>;
    fallbackUsed: boolean;
    latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class CodaiClient {
    #options: CodaiClientOptions;
    #fetch: typeof fetch;

    constructor(options: CodaiClientOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    get baseUrl(): string {
        return this.#options.baseUrl().replace(/\/+$/, "");
    }

    /** Short-lived token (scope `live`) the renderer uses for STT/TTS. */
    async mintLiveToken(ttlSeconds = 600): Promise<Result<LiveToken, CodaiError>> {
        const response = await this.#post("/v1/tokens", { scope: "live", ttl_seconds: ttlSeconds }, 5_000);
        if (!response.ok) return response;
        const body = await readJson(response.value);
        if (!body || typeof body !== "object") return err(invalid("token response is not JSON"));
        const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
        if (typeof token !== "string" || token === "") return err(invalid("token missing"));
        const expires =
            typeof expiresAt === "number"
                ? expiresAt < 1e12
                    ? expiresAt * 1000
                    : expiresAt
                : typeof expiresAt === "string"
                  ? Date.parse(expiresAt)
                  : Number.NaN;
        return ok({ token, expiresAt: Number.isFinite(expires) ? Math.round(expires) : Date.now() + ttlSeconds * 1000 });
    }

    /** Streamed chat completion with sentence-level callbacks for early TTS. */
    async streamChat(request: StreamChatRequest): Promise<Result<StreamChatResult, CodaiError>> {
        const started = performance.now();
        const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

        const response = await this.#post(
            "/v1/chat/completions",
            {
                model: request.model,
                messages: request.messages,
                stream: true,
                max_tokens: request.maxTokens ?? 160,
                temperature: request.temperature ?? 0.7,
            },
            undefined,
            signal,
        );
        if (!response.ok) return response;
        const body = response.value.body;
        if (!body) return err(invalid("empty stream"));

        const parser = new SseParser();
        const splitter = new SentenceSplitter();
        const decoder = new TextDecoder();
        const sentences: string[] = [];
        let text = "";
        let firstSentenceMs: number | null = null;

        const emitSentence = (sentence: string): void => {
            if (firstSentenceMs === null) firstSentenceMs = Math.round(performance.now() - started);
            sentences.push(sentence);
            request.onSentence?.(sentence, sentences.length - 1);
        };
        const handlePayloads = (payloads: string[]): void => {
            for (const payload of payloads) {
                const delta = chatDelta(payload);
                if (delta === null) continue;
                text += delta;
                request.onDelta?.(delta);
                for (const sentence of splitter.push(delta)) emitSentence(sentence);
            }
        };

        try {
            for await (const chunk of body) {
                handlePayloads(parser.push(decoder.decode(chunk, { stream: true })));
            }
            handlePayloads(parser.push(decoder.decode()));
            handlePayloads(parser.end());
        } catch (error) {
            return err(fromThrown(error, signal));
        }
        const rest = splitter.flush();
        if (rest) emitSentence(rest);

        return ok({ text: text.trim(), sentences, firstSentenceMs, totalMs: Math.round(performance.now() - started) });
    }

    /** Non-streamed completion, for cheap background calls (fact extraction). */
    async complete(model: string, messages: ChatMessage[], timeoutMs = 8_000, maxTokens = 300): Promise<Result<string, CodaiError>> {
        const response = await this.#post(
            "/v1/chat/completions",
            { model, messages, stream: false, max_tokens: maxTokens, temperature: 0.2 },
            timeoutMs,
        );
        if (!response.ok) return response;
        const body = (await readJson(response.value)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
        const content = body?.choices?.[0]?.message?.content;
        return typeof content === "string" ? ok(content) : err(invalid("completion has no content"));
    }

    /** System One batch: typed labels for up to 16 items in one call. */
    async systemOne(request: S1BatchRequest): Promise<Result<S1BatchResult, CodaiError>> {
        const timeoutMs = request.timeoutMs ?? 800;
        const response = await this.#post(
            "/v1/systemone",
            {
                items: request.items,
                questions: request.questions,
                timeout_ms: timeoutMs,
                fallback: request.fallback ?? "codai-fast",
            },
            // The gateway's own deadline plus its fallback hop and transport.
            timeoutMs + 4_000,
        );
        if (!response.ok) return response;
        const body = (await readJson(response.value)) as {
            model?: unknown;
            items?: unknown;
            fallback_used?: unknown;
            latency_ms?: unknown;
        } | null;
        if (!body || !Array.isArray(body.items)) return err(invalid("systemone response has no items"));
        const items: S1BatchResult["items"] = [];
        for (const raw of body.items as unknown[]) {
            if (!raw || typeof raw !== "object") continue;
            const { id, answers } = raw as { id?: unknown; answers?: unknown };
            if (typeof id !== "string" || !answers || typeof answers !== "object") continue;
            items.push({ id, answers: answers as Record<string, S1Answer> });
        }
        return ok({
            model: typeof body.model === "string" ? body.model : "codai-s1",
            items,
            fallbackUsed: body.fallback_used === true,
            latencyMs: typeof body.latency_ms === "number" ? body.latency_ms : 0,
        });
    }

    async #post(
        path: string,
        body: unknown,
        timeoutMs: number | undefined,
        signal?: AbortSignal,
    ): Promise<Result<Response, CodaiError>> {
        const key = await this.#options.apiKey();
        if (!key) return err({ kind: "no_key", message: "codai API key is not configured" });

        const effective = signal ?? AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
        let response: Response;
        try {
            response = await this.#fetch(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${key}`,
                    "content-type": "application/json",
                    "x-codai-client": "tiksee-sidecar",
                },
                body: JSON.stringify(body),
                signal: effective,
            });
        } catch (error) {
            return err(fromThrown(error, effective));
        }

        if (response.ok) return ok(response);
        if (response.status === 401) this.#options.onUnauthorized?.();
        return err(await httpError(response));
    }
}

/** Map a non-2xx response to a typed error, reading the codai error envelope. */
export async function httpError(response: Response): Promise<CodaiError> {
    const status = response.status;
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    let message = `HTTP ${status}`;
    try {
        const body = (await response.json()) as { error?: { message?: unknown } | string };
        const detail = typeof body.error === "string" ? body.error : body.error?.message;
        if (typeof detail === "string" && detail !== "") message = detail.slice(0, 300);
    } catch {
        // Non-JSON error body; the status line is enough.
    }
    const kind: CodaiErrorKind =
        status === 401 || status === 403
            ? "unauthorized"
            : status === 429
              ? "rate_limited"
              : status === 503
                ? "unavailable"
                : status >= 500
                  ? "server"
                  : "bad_request";
    return { kind, status, message, retryAfterMs };
}

function fromThrown(error: unknown, signal: AbortSignal): CodaiError {
    const reason: unknown = signal.reason;
    if (signal.aborted) {
        const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
        return { kind: timedOut ? "timeout" : "aborted", message: timedOut ? "codai request timed out" : "codai request aborted" };
    }
    return { kind: "network", message: error instanceof Error ? error.message : "network error" };
}

function invalid(message: string): CodaiError {
    return { kind: "invalid_response", message };
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}
