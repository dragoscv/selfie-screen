import { err, ok, type Result } from "../result.js";

/**
 * Minimal JSON-RPC client for vmui's MCP endpoint (`POST {vmuiUrl}/api/mcp`,
 * stateless, bearer `vmui_*` key). vmui rate-limits light effects per key and
 * answers `{limited:true}` — that is a success (the effect plays once the
 * window ends), not an error.
 */

export interface VmuiOptions {
    baseUrl: () => string;
    apiKey: () => Promise<string | null>;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export interface VmuiCallOk {
    limited: boolean;
    duplicate: boolean;
}

export type SceneArgs = { scene: string; durationSec?: number; idempotencyKey?: string };
export type FlashArgs = { color: string; count: number; durationMs: number; idempotencyKey?: string };

let rpcId = 0;

export class VmuiClient {
    #options: VmuiOptions;
    #fetch: typeof fetch;

    constructor(options: VmuiOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    sceneSet(args: SceneArgs): Promise<Result<VmuiCallOk, string>> {
        return this.#call("scene_set", args);
    }

    flashColor(args: FlashArgs): Promise<Result<VmuiCallOk, string>> {
        return this.#call("flash_color", args);
    }

    async #call(name: string, args: Record<string, unknown>): Promise<Result<VmuiCallOk, string>> {
        const key = await this.#options.apiKey();
        if (!key) return err("vmui API key is not configured");
        const url = `${this.#options.baseUrl().replace(/\/+$/, "")}/api/mcp`;
        rpcId += 1;
        let response: Response;
        try {
            response = await this.#fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
                signal: AbortSignal.timeout(this.#options.timeoutMs ?? 3_000),
            });
        } catch (error) {
            const timedOut = error instanceof DOMException && error.name === "TimeoutError";
            return err(timedOut ? "vmui timed out" : `vmui unreachable: ${error instanceof Error ? error.message : "network error"}`);
        }
        if (!response.ok) return err(`vmui HTTP ${response.status}`);

        let body: { error?: { message?: unknown }; result?: { isError?: unknown; content?: Array<{ text?: unknown }> } };
        try {
            body = (await response.json()) as typeof body;
        } catch {
            return err("vmui answered non-JSON");
        }
        if (body.error) return err(typeof body.error.message === "string" ? body.error.message : "vmui RPC error");
        const text = body.result?.content?.[0]?.text;
        let payload: { ok?: unknown; limited?: unknown; duplicate?: unknown; error?: unknown } = {};
        if (typeof text === "string") {
            try {
                payload = JSON.parse(text) as typeof payload;
            } catch {
                payload = { error: text };
            }
        }
        if (body.result?.isError === true || payload.ok === false) {
            return err(typeof payload.error === "string" ? payload.error.slice(0, 200) : "vmui tool failed");
        }
        return ok({ limited: payload.limited === true, duplicate: payload.duplicate === true });
    }
}
