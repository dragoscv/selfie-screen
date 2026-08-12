import { z } from "zod";

/**
 * The six live-event kinds TikTok surfaces, ported 1:1 from the Android
 * `ChatMessage.Kind` enum so both surfaces agree on semantics and colour.
 */
export const CHAT_KINDS = ["chat", "gift", "follow", "join", "like", "share"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export const chatKindSchema = z.enum(CHAT_KINDS);

/** A viewer as reported by the webcast protocol. */
export const chatUserSchema = z.object({
    /** Stable TikTok user id when available; falls back to the handle. */
    id: z.string(),
    /** `@handle` without the leading `@`. */
    uniqueId: z.string(),
    /** Display name. */
    nickname: z.string(),
    avatarUrl: z.string().optional(),
    isFollower: z.boolean().optional(),
    isSubscriber: z.boolean().optional(),
    isModerator: z.boolean().optional(),
});
export type ChatUser = z.infer<typeof chatUserSchema>;

/**
 * The canonical live event. Every ingestion driver normalises to this shape,
 * and every consumer (UI, overlay, panel, voice, database) reads only this.
 */
export const chatEventSchema = z.object({
    /** Monotonic unique id. Used as the React key and the speech-highlight id. */
    id: z.string(),
    kind: chatKindSchema,
    user: chatUserSchema,
    /** Human-readable body. For non-chat kinds this is a rendered summary. */
    text: z.string(),
    /** Epoch milliseconds. */
    at: z.number().int(),
    /** Which connection produced this (multi-stream support). */
    streamId: z.string(),

    /** gift only */
    giftName: z.string().optional(),
    giftId: z.number().int().optional(),
    /** Repeat/combo count for streakable gifts. */
    giftCount: z.number().int().optional(),
    /** Diamond value of a single gift unit. */
    giftDiamonds: z.number().int().optional(),
    giftImageUrl: z.string().optional(),

    /** like only — number of likes in this batch. */
    likeCount: z.number().int().optional(),

    /** True when the event was produced by the replay engine, not a live stream. */
    replay: z.boolean().optional(),
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

/** Connection lifecycle, mirrored into the UI as a status pill. */
export const CONNECTION_STATES = [
    "offline",
    "connecting",
    "live",
    "reconnecting",
    "ended",
    "error",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const connectionStatusSchema = z.object({
    streamId: z.string(),
    username: z.string(),
    state: z.enum(CONNECTION_STATES),
    roomId: z.string().optional(),
    viewerCount: z.number().int().optional(),
    likeCount: z.number().int().optional(),
    /** Present only when `state === "error"`. */
    error: z.string().optional(),
    /** Epoch ms the current live connection was established. */
    connectedAt: z.number().int().optional(),
});
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** Rolling per-session counters shown on the dashboard. */
export const sessionStatsSchema = z.object({
    streamId: z.string(),
    messages: z.number().int(),
    gifts: z.number().int(),
    follows: z.number().int(),
    joins: z.number().int(),
    likes: z.number().int(),
    shares: z.number().int(),
    uniqueViewers: z.number().int(),
    diamonds: z.number().int(),
    peakViewers: z.number().int(),
    startedAt: z.number().int(),
});
export type SessionStats = z.infer<typeof sessionStatsSchema>;

export function emptySessionStats(streamId: string, startedAt = Date.now()): SessionStats {
    return {
        streamId,
        messages: 0,
        gifts: 0,
        follows: 0,
        joins: 0,
        likes: 0,
        shares: 0,
        uniqueViewers: 0,
        diamonds: 0,
        peakViewers: 0,
        startedAt,
    };
}

/**
 * Monotonic event ids. `Date.now()` alone collides under burst load (many
 * events land in the same millisecond), which would break React keys and the
 * speech-highlight lookup — so we append a per-process counter.
 */
let eventSeq = 0;
export function nextEventId(at: number = Date.now()): string {
    eventSeq = (eventSeq + 1) % 0xffffff;
    return `${at.toString(36)}-${eventSeq.toString(36)}`;
}
