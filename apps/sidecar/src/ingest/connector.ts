import { nextEventId, type ChatEvent, type ChatKind, type ChatUser } from "@tiksee/core";
import { ControlEvent, TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

import { logger } from "../logger.js";
import type {
    ChatSource,
    ChatSourceHandlers,
    ChatSourceStartOptions,
} from "./types.js";

const log = logger.scoped("[connector]");

/** Reconnect backoff: 1s, 2s, 4s, 8s, 16s, then hold at 30s. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Minimal structural views of the protobuf payloads we consume. The library
 * types are extremely wide (100+ fields, mostly `any`), so narrowing to the
 * handful of fields we actually read keeps this file honest about its
 * dependencies and survives upstream field churn.
 */
interface ProtoImage {
    urlList?: string[];
}
interface ProtoUser {
    id?: string;
    idStr?: string;
    /** The `@handle`. Note: it is `displayId`, NOT `uniqueId`. */
    displayId?: string;
    nickname?: string;
    avatarThumb?: ProtoImage;
    avatarMedium?: ProtoImage;
    avatarLarge?: ProtoImage;
    isFollower?: boolean;
    isSubscribe?: boolean;
}
interface ProtoGift {
    id?: string;
    name?: string;
    /** 1 = streakable/combo gift. */
    type?: number;
    combo?: boolean;
    diamondCount?: number;
    image?: ProtoImage;
}

/**
 * Pick an avatar URL, preferring a small raster over the animated/large ones.
 * `urlList` holds several CDN mirrors; the first is fine and `.webp` renders
 * everywhere we draw (DOM, canvas, panel).
 */
function pickAvatar(user: ProtoUser | undefined): string | undefined {
    const list =
        user?.avatarThumb?.urlList ?? user?.avatarMedium?.urlList ?? user?.avatarLarge?.urlList;
    return list?.find((u) => typeof u === "string" && u.startsWith("http"));
}

function toUser(user: ProtoUser | undefined): ChatUser {
    const handle = user?.displayId ?? "";
    return {
        id: user?.id ?? user?.idStr ?? handle ?? "unknown",
        uniqueId: handle,
        nickname: user?.nickname?.trim() || handle || "Someone",
        avatarUrl: pickAvatar(user),
        isFollower: user?.isFollower,
        isSubscriber: user?.isSubscribe,
    };
}

/** Live-chat ingestion backed by `tiktok-live-connector`. */
export class ConnectorSource implements ChatSource {
    readonly name = "connector" as const;

    #conn: TikTokLiveConnection | null = null;
    #handlers: ChatSourceHandlers | null = null;
    #options: ChatSourceStartOptions | null = null;
    #reconnectTimer: NodeJS.Timeout | null = null;
    #attempt = 0;
    /** Set while `stop()` is unwinding so a disconnect does not trigger retry. */
    #stopping = false;
    #running = false;

    get running(): boolean {
        return this.#running;
    }

    async start(options: ChatSourceStartOptions, handlers: ChatSourceHandlers): Promise<void> {
        await this.stop();

        this.#options = options;
        this.#handlers = handlers;
        this.#stopping = false;
        this.#attempt = 0;
        this.#running = true;

        await this.#open();
    }

    async stop(): Promise<void> {
        this.#stopping = true;
        this.#running = false;
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        const conn = this.#conn;
        this.#conn = null;
        if (conn) {
            try {
                await conn.disconnect();
            } catch (error) {
                log.debug("disconnect threw (ignored)", error);
            }
        }
    }

    async #open(): Promise<void> {
        const options = this.#options;
        const handlers = this.#handlers;
        if (!options || !handlers) return;

        const { username, streamId, session, waitUntilLive } = options;
        handlers.onStatus({ state: this.#attempt === 0 ? "connecting" : "reconnecting" });

        // `authenticateWs` stays false: it would forward the session cookie to the
        // third-party signing provider. The cookie is used only for TikTok's own
        // HTTP routes.
        const conn = new TikTokLiveConnection(username, {
            processInitialData: false,
            fetchRoomInfoOnConnect: true,
            enableExtendedGiftInfo: true,
            ...(session
                ? {
                    authenticateWs: false as const,
                    session: {
                        cookie: {
                            type: "cookie" as const,
                            value: { sessionId: session.sessionId, ttTargetIdc: session.ttTargetIdc },
                        },
                    } as never,
                }
                : {}),
        });
        this.#conn = conn;

        this.#wire(conn, streamId, handlers);

        try {
            if (waitUntilLive) {
                const isLive = await conn.fetchIsLive().catch(() => false);
                if (!isLive) {
                    log.info(`@${username} is offline — waiting until live`);
                    handlers.onStatus({ state: "connecting", error: undefined });
                    await conn.waitUntilLive();
                }
            }

            const state = await conn.connect();
            this.#attempt = 0;
            log.info(`connected to @${username} room ${state.roomId}`);
            handlers.onStatus({
                state: "live",
                roomId: state.roomId,
                connectedAt: Date.now(),
                error: undefined,
            });
        } catch (error) {
            const message = describeError(error);
            log.warn(`connect failed for @${username}: ${message}`);
            handlers.onStatus({ state: "error", error: message });
            this.#scheduleReconnect();
        }
    }

    #wire(conn: TikTokLiveConnection, streamId: string, handlers: ChatSourceHandlers): void {
        const emit = (
            kind: ChatKind,
            user: ProtoUser | undefined,
            text: string,
            extra: Partial<ChatEvent> = {},
        ): void => {
            const at = Date.now();
            handlers.onEvent({
                id: nextEventId(at),
                kind,
                user: toUser(user),
                text,
                at,
                streamId,
                ...extra,
            });
        };

        conn.on(WebcastEvent.CHAT, (data) => {
            const payload = data as { user?: ProtoUser; content?: string };
            const text = payload.content?.trim();
            // Empty chat frames exist (emote-only messages); nothing to render.
            if (!text) return;
            emit("chat", payload.user, text);
        });

        conn.on(WebcastEvent.GIFT, (data) => {
            const payload = data as {
                user?: ProtoUser;
                gift?: ProtoGift;
                giftId?: string;
                repeatCount?: number;
                repeatEnd?: number;
            };
            const gift = payload.gift;
            // Streakable gifts (type 1) emit continuously while the streak runs;
            // only settle on the terminating frame or we'd count each tick.
            if (gift?.type === 1 && payload.repeatEnd !== 1) return;

            const count = Math.max(1, payload.repeatCount ?? 1);
            const name = gift?.name ?? "a gift";
            emit("gift", payload.user, count > 1 ? `sent ${name} ×${count} 🎁` : `sent ${name} 🎁`, {
                giftName: gift?.name,
                giftId: Number(gift?.id ?? payload.giftId ?? 0) || undefined,
                giftCount: count,
                giftDiamonds: gift?.diamondCount,
                giftImageUrl: gift?.image?.urlList?.[0],
            });
        });

        conn.on(WebcastEvent.MEMBER, (data) => {
            emit("join", (data as { user?: ProtoUser }).user, "joined");
        });

        conn.on(WebcastEvent.FOLLOW, (data) => {
            emit("follow", (data as { user?: ProtoUser }).user, "followed ✨");
        });

        conn.on(WebcastEvent.SHARE, (data) => {
            emit("share", (data as { user?: ProtoUser }).user, "shared the LIVE 📣");
        });

        conn.on(WebcastEvent.LIKE, (data) => {
            const payload = data as { user?: ProtoUser; count?: number; likeCount?: number };
            const count = payload.likeCount ?? payload.count ?? 1;
            emit("like", payload.user, count > 1 ? `liked ×${count} ❤` : "liked ❤", {
                likeCount: count,
            });
        });

        conn.on(WebcastEvent.ROOM_USER, (data) => {
            const payload = data as { viewerCount?: number };
            if (typeof payload.viewerCount === "number") {
                handlers.onStatus({ state: "live", viewerCount: payload.viewerCount });
            }
        });

        conn.on(WebcastEvent.STREAM_END, () => {
            log.info("stream ended");
            handlers.onStatus({ state: "ended" });
            // The creator ended the broadcast — retrying immediately is pointless.
            this.#stopping = true;
        });

        conn.on(ControlEvent.ERROR, (error) => {
            log.warn("control error", describeError(error));
        });

        conn.on(ControlEvent.DISCONNECTED, () => {
            if (this.#stopping) return;
            log.warn("disconnected — scheduling reconnect");
            handlers.onStatus({ state: "reconnecting" });
            this.#scheduleReconnect();
        });
    }

    #scheduleReconnect(): void {
        if (this.#stopping || !this.#running || this.#reconnectTimer) return;
        const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 30_000;
        this.#attempt += 1;
        log.info(`reconnecting in ${delay}ms (attempt ${this.#attempt})`);
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            void this.#open();
        }, delay);
    }
}

/** Turn any thrown value into a single-line, user-presentable message. */
export function describeError(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
        const maybe = error as { message?: unknown; info?: unknown };
        if (typeof maybe.message === "string") return maybe.message;
        if (typeof maybe.info === "string") return maybe.info;
    }
    return "Unknown error";
}
