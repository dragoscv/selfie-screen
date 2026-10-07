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

/* ------------------------------ goals (WS20-08) ------------------------------ */

export const GOAL_KINDS = ["gifts", "likes"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const goalProgressSchema = z.object({
    kind: z.enum(GOAL_KINDS),
    /** Streamer-chosen label; empty means "use the default caption". */
    label: z.string(),
    current: z.number().int().min(0),
    target: z.number().int().min(1),
    /** 0..1, clamped. */
    ratio: z.number().min(0).max(1),
    reached: z.boolean(),
});
export type GoalProgress = z.infer<typeof goalProgressSchema>;

export const goalsStateSchema = z.object({
    enabled: z.boolean(),
    /** Show the bars in the OBS browser source. */
    overlay: z.boolean(),
    goals: z.array(goalProgressSchema),
});
export type GoalsState = z.infer<typeof goalsStateSchema>;

/* ---------------------------- chat games (WS20-13) ---------------------------- */

export const GAME_KINDS = ["poll", "quiz", "wheel"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const gamePlayerSchema = z.object({ uniqueId: z.string(), nickname: z.string() });
export type GamePlayer = z.infer<typeof gamePlayerSchema>;

export const gameSpecSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("poll"),
        question: z.string().trim().min(1).max(200),
        options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
    }),
    z.object({
        kind: z.literal("quiz"),
        question: z.string().trim().min(1).max(200),
        /** Accepted answers; matching ignores case, diacritics and punctuation. */
        answers: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    }),
    z.object({
        kind: z.literal("wheel"),
        /** Viewers enter by typing this word in chat. */
        keyword: z.string().trim().min(1).max(40),
    }),
]);
export type GameSpec = z.infer<typeof gameSpecSchema>;

export const GAME_ACTIONS = ["close", "spin", "clear"] as const;
export type GameAction = (typeof GAME_ACTIONS)[number];

export const gameStateSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
        kind: z.literal("poll"),
        id: z.string(),
        question: z.string(),
        options: z.array(z.object({ label: z.string(), votes: z.number().int().min(0) })),
        totalVotes: z.number().int().min(0),
        open: z.boolean(),
        startedAt: z.number().int(),
    }),
    z.object({
        kind: z.literal("quiz"),
        id: z.string(),
        question: z.string(),
        open: z.boolean(),
        attempts: z.number().int().min(0),
        winner: gamePlayerSchema.extend({ answer: z.string(), at: z.number().int() }).optional(),
        /** Shown once the quiz is closed. */
        answer: z.string().optional(),
        startedAt: z.number().int(),
    }),
    z.object({
        kind: z.literal("wheel"),
        id: z.string(),
        keyword: z.string(),
        open: z.boolean(),
        entrantCount: z.number().int().min(0),
        /** Up to 24 names drawn on the wheel; always contains the winner once spun. */
        segments: z.array(z.string()),
        spinning: z.boolean(),
        winnerIndex: z.number().int().min(0).optional(),
        winner: gamePlayerSchema.optional(),
        spinAt: z.number().int().optional(),
        startedAt: z.number().int(),
    }),
]);
export type GameState = z.infer<typeof gameStateSchema>;

/* ------------------------- post-live summary (WS20-10) ------------------------- */

export const sessionInfoSchema = z.object({
    id: z.number().int(),
    username: z.string(),
    startedAt: z.number().int(),
    endedAt: z.number().int().optional(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const MOMENT_KINDS = ["gift", "highlight", "spike"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

export const summaryMomentSchema = z.object({
    at: z.number().int(),
    kind: z.enum(MOMENT_KINDS),
    /** Viewer nickname, highlight note or "N msgs/min". */
    title: z.string(),
    detail: z.string(),
    /** Diamonds for gifts, messages per minute for spikes, 0 for highlights. */
    value: z.number(),
});
export type SummaryMoment = z.infer<typeof summaryMomentSchema>;

export const summaryViewerSchema = z.object({
    uniqueId: z.string(),
    nickname: z.string(),
    messages: z.number().int(),
    gifts: z.number().int(),
    diamonds: z.number().int(),
});
export type SummaryViewer = z.infer<typeof summaryViewerSchema>;

export const sessionSummarySchema = z.object({
    session: sessionInfoSchema,
    durationMs: z.number().int().min(0),
    stats: z.object({
        messages: z.number().int(),
        gifts: z.number().int(),
        diamonds: z.number().int(),
        follows: z.number().int(),
        shares: z.number().int(),
        joins: z.number().int(),
        likes: z.number().int(),
        uniqueViewers: z.number().int(),
        peakViewers: z.number().int(),
    }),
    moments: z.array(summaryMomentSchema),
    topViewers: z.array(summaryViewerSchema),
    /** Messages and diamonds per minute since the start. */
    timeline: z.array(z.object({ minute: z.number().int(), messages: z.number().int(), diamonds: z.number().int() })),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/* ----------------------------- UI → sidecar ----------------------------- */

export const liveClientMessages = [
    z.object({ type: z.literal("control"), action: z.enum(CONTROL_ACTIONS) }),
    z.object({ type: z.literal("replyApprove"), id: z.string(), text: z.string().max(500).optional() }),
    z.object({ type: z.literal("replySkip"), id: z.string() }),
    /** Speak arbitrary text now (settings test button, manual announcements). */
    /** Manual line (or a voice audition): optional voice and prosody override the co-host's. */
    z.object({
        type: z.literal("speak"),
        text: z.string().min(1).max(500),
        voice: z.string().max(40).optional(),
        speed: z.number().min(0.5).max(1.5).optional(),
        pitch: z.number().min(0.6).max(1.6).optional(),
    }),
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
    /** Reset the goal counters to zero (new goal round). */
    z.object({ type: z.literal("goalsReset") }),
    z.object({ type: z.literal("gameStart"), game: gameSpecSchema }),
    z.object({ type: z.literal("gameAction"), action: z.enum(GAME_ACTIONS) }),
    z.object({ type: z.literal("summaryList") }),
    /** Omit `sessionId` for the most recent session. */
    z.object({ type: z.literal("summaryRequest"), sessionId: z.number().int().optional() }),
    /** The sidecar writes the file; `path` comes from the native save dialog. */
    z.object({
        type: z.literal("summaryExport"),
        sessionId: z.number().int(),
        format: z.enum(EXPORT_FORMATS),
        path: z.string().min(1).max(1024),
    }),
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
        /** Tempo for this utterance (absent = voice.speed). */
        speed: z.number().min(0.5).max(1.5).optional(),
        /** Pitch for this utterance, independent of tempo (absent = 1). */
        pitch: z.number().min(0.6).max(1.6).optional(),
        eventId: z.string().optional(),
    }),
    z.object({ type: z.literal("sayCancel"), id: z.string() }),
    /** Viseme timeline of the utterance now playing, for the studio pets' lip-sync. */
    z.object({ type: z.literal("speech"), id: z.string(), visemes: z.array(visemeSchema) }),
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
    z.object({ type: z.literal("goals"), state: goalsStateSchema }),
    z.object({ type: z.literal("game"), state: gameStateSchema }),
    /** Inline Romanian translation of a foreign chat message (WS20-14). */
    z.object({ type: z.literal("translation"), eventId: z.string(), lang: z.string(), text: z.string() }),
    /** Translation of one final transcript line (`itemId` = the STT item) into studio.captions.lang. */
    z.object({ type: z.literal("transcriptTranslation"), itemId: z.string(), lang: z.string(), text: z.string() }),
    z.object({ type: z.literal("summaries"), sessions: z.array(sessionInfoSchema) }),
    z.object({
        type: z.literal("summary"),
        summary: sessionSummarySchema.optional(),
        /** True when pushed because a live session just ended. */
        auto: z.boolean().default(false),
        error: z.string().optional(),
    }),
    z.object({
        type: z.literal("summaryExported"),
        path: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
    }),
] as const;
