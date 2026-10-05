import { z } from "zod";

/**
 * Live-studio contract: co-host replies, speech, Live Control, studio cards
 * and smart-home effects. Shared by the sidecar (decisions), the renderer
 * (audio I/O and UI) and the OBS overlay.
 *
 * Ownership: the sidecar owns the queue and every decision; the renderer owns
 * the microphone and the speaker (device selection lives in WebAudio), so
 * audio never crosses the loopback socket.
 */

export const CONTROL_ACTIONS = [
    "muteAssistant",
    "unmuteAssistant",
    "pauseReplies",
    "resumeReplies",
    "skipCurrent",
    "effectsOff",
    "effectsOn",
    "shopModeOn",
    "shopModeOff",
    "petsHide",
    "petsShow",
    "highlight",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** Runtime Live Control state; not persisted, resets on every launch. */
export const liveControlStateSchema = z.object({
    muted: z.boolean().default(false),
    repliesPaused: z.boolean().default(false),
    effectsOff: z.boolean().default(false),
    /** TikTok Shop LIVE forbids AI voices: no TTS at all while on. */
    shopMode: z.boolean().default(false),
    petsHidden: z.boolean().default(false),
    /** Id of the utterance currently playing, if any. */
    speakingId: z.string().optional(),
});
export type LiveControlState = z.infer<typeof liveControlStateSchema>;

export const REPLY_STATUSES = ["pending", "drafting", "ready", "speaking", "done", "skipped", "failed"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export const replyItemSchema = z.object({
    id: z.string(),
    /** Chat event that triggered the reply; absent for streamer-initiated ones. */
    eventId: z.string().optional(),
    uniqueId: z.string(),
    nickname: z.string(),
    avatarUrl: z.string().optional(),
    /** What the viewer said. */
    message: z.string(),
    /** Deterministic priority, higher first. */
    score: z.number(),
    /** Why it scored: "gift", "question", "first-time", "mention"... */
    reasons: z.array(z.string()).default([]),
    draft: z.string().optional(),
    status: z.enum(REPLY_STATUSES),
    at: z.number().int(),
});
export type ReplyItem = z.infer<typeof replyItemSchema>;

export const viewerCardSchema = z.object({
    uniqueId: z.string(),
    nickname: z.string(),
    avatarUrl: z.string().optional(),
    visits: z.number().int(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    messages: z.number().int(),
    totalDiamonds: z.number().int(),
    facts: z.array(z.string()).default([]),
    greeting: z.string().optional(),
});
export type ViewerCard = z.infer<typeof viewerCardSchema>;

export const SUGGESTION_KINDS = ["unanswered", "quiet", "thanks", "spike", "topic", "goal"] as const;
export const suggestionSchema = z.object({
    id: z.string(),
    kind: z.enum(SUGGESTION_KINDS),
    text: z.string(),
    at: z.number().int(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

export const effectFiredSchema = z.object({
    id: z.string(),
    kind: z.enum(["flash", "scene"]),
    label: z.string(),
    /** Viewer handle, "gift:<name>", "voice" or "manual". */
    by: z.string(),
    at: z.number().int(),
    limited: z.boolean().default(false),
    error: z.string().optional(),
});
export type EffectFired = z.infer<typeof effectFiredSchema>;

export const visemeSchema = z.object({ id: z.number().int(), offsetMs: z.number() });
export const wordMarkSchema = z.object({ text: z.string(), offsetMs: z.number(), durationMs: z.number() });

/* ----------------------------- UI → sidecar ----------------------------- */

export const liveClientMessages = [
    z.object({ type: z.literal("control"), action: z.enum(CONTROL_ACTIONS) }),
    z.object({ type: z.literal("replyApprove"), id: z.string(), text: z.string().max(500).optional() }),
    z.object({ type: z.literal("replySkip"), id: z.string() }),
    /** Speak arbitrary text now (settings test button, manual announcements). */
    z.object({ type: z.literal("speak"), text: z.string().min(1).max(500) }),
    /** Streamer transcript from the renderer's realtime STT session. */
    z.object({
        type: z.literal("transcript"),
        itemId: z.string(),
        text: z.string(),
        final: z.boolean(),
        at: z.number().int(),
    }),
    z.object({
        type: z.literal("sayState"),
        id: z.string(),
        state: z.enum(["playing", "done", "error"]),
        error: z.string().optional(),
    }),
    /** Viseme timeline of the utterance now playing, relayed to the overlay pets. */
    z.object({
        type: z.literal("speechTimeline"),
        id: z.string(),
        visemes: z.array(visemeSchema),
        words: z.array(wordMarkSchema),
    }),
    /** Ask for a short-lived codai token (scope `live`) for STT/TTS. */
    z.object({ type: z.literal("codaiToken") }),
    z.object({ type: z.literal("effectTest"), kind: z.enum(["flash", "scene"]), value: z.string() }),
] as const;

/* ----------------------------- sidecar → UI ----------------------------- */

export const liveServerMessages = [
    z.object({ type: z.literal("liveControl"), state: liveControlStateSchema }),
    z.object({ type: z.literal("replyQueue"), items: z.array(replyItemSchema) }),
    /** Play this utterance; the renderer answers with `sayState`. */
    z.object({
        type: z.literal("say"),
        id: z.string(),
        text: z.string(),
        voice: z.string(),
        eventId: z.string().optional(),
    }),
    z.object({ type: z.literal("sayCancel"), id: z.string() }),
    z.object({ type: z.literal("viewerCard"), card: viewerCardSchema }),
    z.object({ type: z.literal("suggestion"), suggestion: suggestionSchema }),
    z.object({ type: z.literal("effect"), effect: effectFiredSchema }),
    z.object({
        type: z.literal("codaiToken"),
        token: z.string().optional(),
        baseUrl: z.string(),
        expiresAt: z.number().int().optional(),
        error: z.string().optional(),
    }),
] as const;
