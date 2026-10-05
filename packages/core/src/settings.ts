import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Appearance — the three orthogonal theme axes plus locale.
 * ------------------------------------------------------------------ */

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Accent presets. `cyan` reproduces the original Android accent `#62D6FF`. */
export const ACCENT_PRESETS = ["cyan", "violet", "amber", "emerald", "rose", "sky"] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];

/** Surface treatment. `mica`/`glass` map to real Windows 11 backdrops. */
export const SURFACE_MODES = ["solid", "glass", "mica", "contrast"] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];

export const LOCALES = ["system", "en", "ro"] as const;
export type Locale = (typeof LOCALES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const appearanceSchema = z.object({
    mode: z.enum(THEME_MODES).default("dark"),
    accent: z.enum(ACCENT_PRESETS).default("cyan"),
    /** Custom OKLCH hue 0..360; overrides `accent` when set. */
    customAccentHue: z.number().min(0).max(360).optional(),
    /** Custom OKLCH chroma 0..0.4; used with `customAccentHue`. */
    customAccentChroma: z.number().min(0).max(0.4).optional(),
    surface: z.enum(SURFACE_MODES).default("mica"),
    locale: z.enum(LOCALES).default("system"),
    density: z.enum(DENSITIES).default("comfortable"),
    /** Force-disable animation regardless of the OS setting. */
    reducedMotion: z.boolean().default(false),
    fontScale: z.number().min(0.8).max(1.4).default(1),
});
export type Appearance = z.infer<typeof appearanceSchema>;

/* ------------------------------------------------------------------ *
 * Read-aloud filters — 1:1 with Android `ReadFilters`.
 * ------------------------------------------------------------------ */

export const readFiltersSchema = z.object({
    chat: z.boolean().default(true),
    gifts: z.boolean().default(true),
    follows: z.boolean().default(true),
    /** Off by default — joins get noisy fast. */
    joins: z.boolean().default(false),
    /** Off by default — likes are extremely frequent. */
    likes: z.boolean().default(false),
    shares: z.boolean().default(true),
});
export type ReadFilters = z.infer<typeof readFiltersSchema>;

/* ------------------------------------------------------------------ *
 * Voice — full parity with the Android `VoiceConfig` voice block.
 * ------------------------------------------------------------------ */

/** codai-tts-ro voices (Azure Speech ro-RO neural, with visemes). */
export const VOICES = ["alina", "emil"] as const;
export type Voice = (typeof VOICES)[number];

export const SPEECH_LANGUAGES = ["auto", "ro", "en"] as const;
/** `codai` streams codai-tts-ro; `system` falls back to the OS voice. */
export const SPEECH_ENGINES = ["codai", "system", "off"] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

export const voiceSchema = z.object({
    enabled: z.boolean().default(true),
    engine: z.enum(SPEECH_ENGINES).catch("codai").default("codai"),
    voice: z.enum(VOICES).catch("alina").default("alina"),
    /** System-voice URI, used when `engine === "system"`. */
    systemVoiceUri: z.string().default(""),
    speed: z.number().min(0.5).max(1.5).default(1),
    pitch: z.number().min(0.6).max(1.4).default(1),
    volume: z.number().min(0).max(1).default(1),
    filters: readFiltersSchema.prefault({}),
    minGiftValueToRead: z.number().int().min(0).default(0),
    readUsernames: z.boolean().default(true),
    language: z.enum(SPEECH_LANGUAGES).default("auto"),
});
export type VoiceSettings = z.infer<typeof voiceSchema>;

/*
 * NOTE on `.prefault({})` below: in Zod 4 `.default(value)` short-circuits and
 * returns `value` verbatim without running the inner schema, so a nested
 * `.default({})` would yield a literal `{}` with none of its own field
 * defaults. `.prefault({})` feeds the value THROUGH the schema, which is what
 * we want for every nested section.
 */

/* ------------------------------------------------------------------ *
 * AI co-host.
 * ------------------------------------------------------------------ */

export const assistantSchema = z.object({
    aiReplies: z.boolean().default(false),
    aiInitiates: z.boolean().default(false),
    idleChatterSeconds: z.number().int().min(30).max(600).default(120),
    pushToTalk: z.boolean().default(false),
    personaName: z.string().default("Codai"),
    aboutMe: z.string().default(""),
    personality: z.string().default("prietenos, glumeț, concis"),
    /** Replies per minute the token bucket refills; burst = 2. */
    repliesPerMinute: z.number().int().min(1).max(20).default(4),
    /** `auto` speaks drafts at once; `approve` waits for the streamer. */
    replyMode: z.enum(["auto", "approve"]).default("approve"),
    /** Never start speaking within this many ms of the streamer's last word. */
    quietAfterStreamerMs: z.number().int().min(0).max(10_000).default(1500),
    /** Transcribe the streamer's microphone continuously. */
    transcribe: z.boolean().default(false),
    /** Use System One to enrich triage (question, intent, emotion). */
    useSystemOne: z.boolean().default(true),
});
export type AssistantSettings = z.infer<typeof assistantSchema>;

/* ------------------------------------------------------------------ *
 * Safety, throughput and moderation.
 * ------------------------------------------------------------------ */

export const safetySchema = z.object({
    moderation: z.boolean().default(true),
    maxQueue: z.number().int().min(3).max(20).default(8),
    skipDuplicates: z.boolean().default(true),
    greetReturningViewers: z.boolean().default(true),
    thankGifts: z.boolean().default(true),
    /** Words that hide a message entirely. */
    blockedWords: z.array(z.string()).default([]),
    /** Handles whose messages are hidden entirely. */
    blockedUsers: z.array(z.string()).default([]),
    /** Words that raise an alert (toast + optional sound + notification). */
    alertKeywords: z.array(z.string()).default([]),
    hideSpam: z.boolean().default(true),
    /** Identical messages within this window from one user count as spam. */
    spamWindowMs: z.number().int().min(1000).max(120_000).default(15_000),
});
export type SafetySettings = z.infer<typeof safetySchema>;

/* ------------------------------------------------------------------ *
 * Display / aggregation.
 * ------------------------------------------------------------------ */

export const displaySchema = z.object({
    collapseJoinsFeed: z.boolean().default(false),
    collapseLikesFeed: z.boolean().default(false),
    collapseJoinsPanel: z.boolean().default(true),
    collapseLikesPanel: z.boolean().default(true),
    collapseJoinsOverlay: z.boolean().default(true),
    collapseLikesOverlay: z.boolean().default(true),
    mergeSameUser: z.boolean().default(true),
    showAvatars: z.boolean().default(true),
    showTimestamps: z.boolean().default(true),
    /** Cap on retained events per stream; older ones are trimmed from memory. */
    maxFeedEvents: z.number().int().min(50).max(5000).default(500),
});
export type DisplaySettings = z.infer<typeof displaySchema>;

/* ------------------------------------------------------------------ *
 * Floating overlay window.
 * ------------------------------------------------------------------ */

export const overlaySchema = z.object({
    enabled: z.boolean().default(false),
    opacity: z.number().min(0.15).max(1).default(0.82),
    blur: z.number().min(0).max(1).default(0.35),
    x: z.number().int().default(24),
    y: z.number().int().default(200),
    width: z.number().int().min(240).max(900).default(360),
    height: z.number().int().min(200).max(1400).default(460),
    clickThrough: z.boolean().default(false),
    alwaysOnTop: z.boolean().default(true),
    compact: z.boolean().default(false),
});
export type OverlaySettings = z.infer<typeof overlaySchema>;

/* ------------------------------------------------------------------ *
 * OBS browser source + scene control.
 * ------------------------------------------------------------------ */

export const OVERLAY_LAYOUTS = ["stack", "bubbles", "ticker", "minimal"] as const;
export type OverlayLayout = (typeof OVERLAY_LAYOUTS)[number];

export const obsSchema = z.object({
    browserSourceEnabled: z.boolean().default(true),
    /** 0 lets the OS pick a free port; the resolved port is reported at runtime. */
    port: z.number().int().min(0).max(65535).default(0),
    layout: z.enum(OVERLAY_LAYOUTS).default("stack"),
    transparent: z.boolean().default(true),
    maxRows: z.number().int().min(3).max(30).default(8),
    /** Remove a row this long after it arrives; 0 keeps it until pushed out. */
    rowTtlMs: z.number().int().min(0).max(600_000).default(0),
    /** obs-websocket remote control. */
    controlEnabled: z.boolean().default(false),
    controlUrl: z.string().default("ws://127.0.0.1:4455"),
});
export type ObsSettings = z.infer<typeof obsSchema>;

/* ------------------------------------------------------------------ *
 * USB LCD panel.
 * ------------------------------------------------------------------ */

export const panelSchema = z.object({
    enabled: z.boolean().default(false),
    /** Empty means auto-detect by USB VID/PID. */
    portPath: z.string().default(""),
    brightness: z.number().int().min(0).max(100).default(90),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    showClock: z.boolean().default(true),
});
export type PanelSettings = z.infer<typeof panelSchema>;

/* ------------------------------------------------------------------ *
 * Alerts, behaviour, integrations.
 * ------------------------------------------------------------------ */

export const alertsSchema = z.object({
    soundEnabled: z.boolean().default(true),
    soundVolume: z.number().min(0).max(1).default(0.6),
    notifyOnGift: z.boolean().default(true),
    notifyOnFollow: z.boolean().default(false),
    notifyOnKeyword: z.boolean().default(true),
    /** Only gifts worth at least this many diamonds raise an alert. */
    giftDiamondThreshold: z.number().int().min(0).default(1),
});
export type AlertSettings = z.infer<typeof alertsSchema>;

export const behaviourSchema = z.object({
    autostart: z.boolean().default(false),
    startMinimised: z.boolean().default(false),
    minimiseToTray: z.boolean().default(true),
    closeToTray: z.boolean().default(true),
    /** Reconnect to the last creator on launch. */
    autoReconnect: z.boolean().default(true),
    /** Poll a creator until they go live, then connect automatically. */
    waitUntilLive: z.boolean().default(false),
    crashReporting: z.boolean().default(false),
    /** Global shortcut accelerators, Tauri syntax. */
    hotkeyToggleOverlay: z.string().default("CommandOrControl+Shift+O"),
    hotkeyMuteVoice: z.string().default("CommandOrControl+Shift+M"),
    hotkeyPushToTalk: z.string().default("CommandOrControl+Shift+T"),
    hotkeyPauseReplies: z.string().default("CommandOrControl+Shift+P"),
    hotkeySkipReply: z.string().default("CommandOrControl+Shift+S"),
    hotkeyEffectsOff: z.string().default("CommandOrControl+Shift+E"),
    hotkeyHighlight: z.string().default("CommandOrControl+Shift+H"),
    /** Local HTTP trigger endpoints for Stream Deck / MIDI bridges. */
    triggerServerEnabled: z.boolean().default(false),
});
export type BehaviourSettings = z.infer<typeof behaviourSchema>;

export const dataSchema = z.object({
    persistHistory: z.boolean().default(true),
    /** Sessions older than this are pruned; 0 keeps forever. */
    retentionDays: z.number().int().min(0).max(3650).default(365),
    trackEarnings: z.boolean().default(true),
    /** USD per diamond used for the earnings estimate. */
    diamondRateUsd: z.number().min(0).max(1).default(0.005),
    recordSessions: z.boolean().default(false),
});
export type DataSettings = z.infer<typeof dataSchema>;

/* ------------------------------------------------------------------ *
 * codai (AI gateway) — key lives in the OS credential store.
 * ------------------------------------------------------------------ */

export const codaiSchema = z.object({
    baseUrl: z.string().default("https://ai.codai.ro"),
    /** Model for reply drafting; hidden fast alias of the `codai` router. */
    replyModel: z.string().default("codai-fast"),
    sttModel: z.string().default("codai-transcribe-live"),
    ttsModel: z.string().default("codai-tts-ro"),
});
export type CodaiSettings = z.infer<typeof codaiSchema>;

/* ------------------------------------------------------------------ *
 * Audio devices (WebAudio sink / mic ids; "" = system default).
 * ------------------------------------------------------------------ */

export const audioSchema = z.object({
    outputDeviceId: z.string().default(""),
    inputDeviceId: z.string().default(""),
    /** Lower TTS volume to this fraction while the streamer is talking. */
    duckTo: z.number().min(0).max(1).default(0.35),
});
export type AudioSettings = z.infer<typeof audioSchema>;

/* ------------------------------------------------------------------ *
 * Smart-home effects through vmui MCP.
 * ------------------------------------------------------------------ */

export const STREAM_SCENES = ["party", "calm", "red_alert", "gift_gold", "rainbow", "blackout_flash", "default"] as const;
export const FLASH_COLORS = ["red", "green", "blue", "cyan", "purple", "pink", "gold", "orange", "white"] as const;

export const giftEffectTierSchema = z.object({
    minDiamonds: z.number().int().min(1),
    scene: z.enum(STREAM_SCENES),
    durationSec: z.number().int().min(1).max(600).default(15),
});

export const effectsSchema = z.object({
    enabled: z.boolean().default(false),
    /** vmui base URL; LAN IP is ~20x faster than the tailnet name. */
    vmuiUrl: z.string().default("http://192.168.100.232:3737"),
    /** Viewers may type `!red`, `!party`… for small effects. */
    chatCommands: z.boolean().default(true),
    perUserCooldownSec: z.number().int().min(5).max(3600).default(60),
    globalCooldownSec: z.number().int().min(1).max(600).default(3),
    /** Colours a free chat command may flash. */
    allowedColors: z.array(z.enum(FLASH_COLORS)).default([...FLASH_COLORS]),
    /** Scenes a free chat command may trigger (gifts can trigger any tier scene). */
    allowedChatScenes: z.array(z.enum(STREAM_SCENES)).default([]),
    giftTiers: z.array(giftEffectTierSchema).default([
        { minDiamonds: 1, scene: "gift_gold", durationSec: 8 },
        { minDiamonds: 99, scene: "party", durationSec: 20 },
        { minDiamonds: 499, scene: "rainbow", durationSec: 45 },
    ]),
});
export type EffectsSettings = z.infer<typeof effectsSchema>;

export const connectionSchema = z.object({
    /** Default creator handle, without `@`. */
    username: z.string().default(""),
    /** Additional handles for multi-stream split view. */
    extraUsernames: z.array(z.string()).default([]),
    /** `connector` = tiktok-live-connector; `sniffer` = embedded browser. */
    driver: z.enum(["connector", "sniffer"]).default("connector"),
    /** Send the stored TikTok session cookie with TikTok's own HTTP routes. */
    useSession: z.boolean().default(true),
});
export type ConnectionSettings = z.infer<typeof connectionSchema>;

/* ------------------------------------------------------------------ *
 * Stream goals (WS20-08).
 * ------------------------------------------------------------------ */

export const goalSchema = z.object({
    enabled: z.boolean().default(true),
    /** Empty uses the default caption. */
    label: z.string().max(60).default(""),
    target: z.number().int().min(1).max(100_000_000),
});
export type GoalSettings = z.infer<typeof goalSchema>;

export const goalsSchema = z.object({
    enabled: z.boolean().default(false),
    /** Show the bars in the OBS browser source. */
    showInOverlay: z.boolean().default(true),
    gifts: goalSchema.prefault({ target: 1000 }),
    likes: goalSchema.prefault({ target: 10_000 }),
});
export type GoalsSettings = z.infer<typeof goalsSchema>;

/* ------------------------------------------------------------------ *
 * Chat games (WS20-13).
 * ------------------------------------------------------------------ */

export const gamesSchema = z.object({
    /** Show the running game in the OBS browser source. */
    showInOverlay: z.boolean().default(true),
    /** One vote per viewer; a later vote replaces the earlier one. */
    allowVoteChange: z.boolean().default(false),
    /** Wheel entrants must also be followers. */
    wheelFollowersOnly: z.boolean().default(false),
    /** Announce winners through the co-host voice. */
    announceWinners: z.boolean().default(true),
});
export type GamesSettings = z.infer<typeof gamesSchema>;

/* ------------------------------------------------------------------ *
 * Live translation (WS20-14).
 * ------------------------------------------------------------------ */

export const translationSchema = z.object({
    enabled: z.boolean().default(false),
    /** Messages shorter than this (in letters) are never translated. */
    minLetters: z.number().int().min(2).max(40).default(6),
});
export type TranslationSettings = z.infer<typeof translationSchema>;

/* ------------------------------------------------------------------ *
 * Studio: camera + filters + 3D pets in one frame (P4, decision Q33).
 * ------------------------------------------------------------------ */

export const PET_CHOICES = ["none", "parrot", "cat", "dragon", "drone", "fox", "owl", "redpanda"] as const;
export type PetChoice = (typeof PET_CHOICES)[number];
export const STUDIO_ORIENTATIONS = ["portrait", "landscape"] as const;
export const PET_STYLES = ["pbr", "toon"] as const;
/** Degrees clockwise to turn the camera image upright (camera mounted in portrait). */
export const CAMERA_ROTATIONS = [0, 90, 180, 270] as const;

export const studioSchema = z.object({
    enabled: z.boolean().default(false),
    /** MediaDeviceInfo.deviceId; empty picks a device labelled "USB3.0 Video", else the first camera. */
    cameraId: z.string().default(""),
    /** portrait 1080x1920 (TikTok), landscape 1920x1080 (Q38). */
    orientation: z.enum(STUDIO_ORIENTATIONS).default("portrait"),
    rotation: z.union(CAMERA_ROTATIONS.map((r) => z.literal(r))).default(0),
    mirror: z.boolean().default(true),
    leftPet: z.enum(PET_CHOICES).default("parrot"),
    rightPet: z.enum(PET_CHOICES).default("none"),
    petStyle: z.enum(PET_STYLES).default("pbr"),
    /** 0..1 skin smoothing strength (bilateral). */
    smoothing: z.number().min(0).max(1).default(0.35),
    /** 0..1 background blur, needs the person segmentation mask. */
    backgroundBlur: z.number().min(0).max(1).default(0),
    /** Exposure in stops, -2..2. */
    exposure: z.number().min(-2).max(2).default(0),
    /** White-balance shift, -1 cool .. 1 warm. */
    warmth: z.number().min(-1).max(1).default(0),
    /** Show the fps/frame-time HUD in the studio window (never in the captured frame). */
    showStats: z.boolean().default(false),
});
export type StudioSettings = z.infer<typeof studioSchema>;

/* ------------------------------------------------------------------ *
 * Root.
 * ------------------------------------------------------------------ */

export const settingsSchema = z.object({
    version: z.literal(1).default(1),
    appearance: appearanceSchema.prefault({}),
    connection: connectionSchema.prefault({}),
    voice: voiceSchema.prefault({}),
    assistant: assistantSchema.prefault({}),
    safety: safetySchema.prefault({}),
    display: displaySchema.prefault({}),
    overlay: overlaySchema.prefault({}),
    obs: obsSchema.prefault({}),
    panel: panelSchema.prefault({}),
    alerts: alertsSchema.prefault({}),
    behaviour: behaviourSchema.prefault({}),
    data: dataSchema.prefault({}),
    codai: codaiSchema.prefault({}),
    audio: audioSchema.prefault({}),
    effects: effectsSchema.prefault({}),
    goals: goalsSchema.prefault({}),
    games: gamesSchema.prefault({}),
    translation: translationSchema.prefault({}),
    studio: studioSchema.prefault({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Fully-populated defaults. Never throws — the schema has a default for all. */
export function defaultSettings(): Settings {
    return settingsSchema.parse({});
}

/**
 * Parse persisted settings, repairing anything invalid instead of throwing.
 * A corrupt or partially-written config file must never brick the app, so
 * unknown/invalid leaves fall back to their defaults.
 */
export function parseSettings(raw: unknown): Settings {
    const result = settingsSchema.safeParse(raw);
    if (result.success) return result.data;

    if (raw && typeof raw === "object") {
        const base = defaultSettings();
        const merged: Record<string, unknown> = { ...base };
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (!(key in base)) continue;
            const section = settingsSchema.shape[key as keyof typeof settingsSchema.shape];
            const parsed = section.safeParse(value);
            if (parsed.success) merged[key] = parsed.data;
        }
        const retry = settingsSchema.safeParse(merged);
        if (retry.success) return retry.data;
    }
    return defaultSettings();
}
