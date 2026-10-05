import type { ServerMessage } from "@tiksee/core";

import { sidecarClient } from "./sidecar-client.js";

export interface CodaiToken {
    token: string;
    baseUrl: string;
    expiresAt: number;
}

/** Refresh this long before the token expires so a stream never starts on a dying token. */
const REFRESH_MARGIN_MS = 60_000;
/** Lifetime assumed when the sidecar does not say. */
const DEFAULT_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

let cached: CodaiToken | null = null;
let inflight: Promise<CodaiToken> | null = null;

type TokenReply = Extract<ServerMessage, { type: "codaiToken" }>;

function request(): Promise<CodaiToken> {
    return new Promise<CodaiToken>((resolve, reject) => {
        const finish = (fn: () => void) => {
            window.clearTimeout(timer);
            off();
            fn();
        };
        const off = sidecarClient.onMessage((message) => {
            if (message.type !== "codaiToken") return;
            const reply: TokenReply = message;
            if (!reply.token) {
                finish(() => reject(new Error(reply.error ?? "codai token unavailable")));
                return;
            }
            const token: CodaiToken = {
                token: reply.token,
                baseUrl: reply.baseUrl.replace(/\/+$/, ""),
                expiresAt: reply.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
            };
            finish(() => resolve(token));
        });
        const timer = window.setTimeout(
            () => finish(() => reject(new Error("codai token request timed out"))),
            REQUEST_TIMEOUT_MS,
        );
        sidecarClient.send({ type: "codaiToken" });
    });
}

/**
 * A short-lived codai token (scope `live`) minted by the sidecar, which holds
 * the real API key. Cached until a minute before expiry; concurrent callers
 * share one request. The token itself is never logged.
 */
export async function getCodaiToken(): Promise<CodaiToken> {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached;
    inflight ??= request()
        .then((token) => {
            cached = token;
            return token;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

/** Drop the cached token, e.g. after the gateway answered 401. */
export function invalidateCodaiToken(): void {
    cached = null;
}
