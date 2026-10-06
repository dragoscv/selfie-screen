import { z } from "zod";

import { SIGNAL_FAMILIES, defaultRules, ruleSchema } from "./vision.js";

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
    /** Save the last N seconds of the studio output as an MP4 (WS28-07). K = "klip"; Ctrl+Alt+C was already taken on the owner's PC, C/V/X are copy/paste. */
    hotkeySaveClip: z.string().default("CommandOrControl+Shift+K"),
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

export const GUIDE_KINDS = ["none", "thirds", "golden", "grid", "center"] as const;
export const PEAKING_COLORS = ["red", "yellow", "white", "blue"] as const;
export const SCOPE_KINDS = ["none", "histogram", "waveform", "parade", "vectorscope"] as const;

/** Pro monitoring aids drawn in the studio preview only (two render targets: output never has them). */
export const monitorSchema = z.object({
    peaking: z.boolean().default(false),
    peakingColor: z.enum(PEAKING_COLORS).default("red"),
    /** Lower = more edges highlighted. */
    peakingThreshold: z.number().min(0.03).max(0.5).default(0.15),
    zebra: z.boolean().default(false),
    /** IRE 50..100. */
    zebraLevel: z.number().int().min(50).max(100).default(95),
    falseColor: z.boolean().default(false),
    clipping: z.boolean().default(false),
    guides: z.enum(GUIDE_KINDS).default("thirds"),
    safeZones: z.boolean().default(true),
    scope: z.enum(SCOPE_KINDS).default("none"),
    afBox: z.boolean().default(true),
    horizon: z.boolean().default(true),
    /** 2x/4x magnifier on the eyes while held. */
    loupeZoom: z.union([z.literal(2), z.literal(4)]).default(2),
    /** Hide every preview aid (what the viewers see). */
    cleanFeed: z.boolean().default(false),
});
export type MonitorSettings = z.infer<typeof monitorSchema>;

export const framingSchema = z.object({
    /** Digital zoom 1..2.5 on top of the optical BLE zoom. */
    zoom: z.number().min(1).max(2.5).default(1),
    /** Follow the owner's face with a spring-smoothed crop. */
    autoReframe: z.boolean().default(false),
    /** Dead zone as a fraction of the frame before the crop moves. */
    deadZone: z.number().min(0).max(0.3).default(0.08),
    /** Widen on standing up or a second person. */
    smartWide: z.boolean().default(true),
    /** Synthetic depth of field: the face stays sharp, the rest blurs by distance. */
    dof: z.boolean().default(false),
    dofStrength: z.number().min(0).max(1).default(0.5),
    /** Auto AF (BLE half-press) when the face returns or every N s while it moves; 0 = off. */
    afIntervalS: z.number().int().min(0).max(120).default(0),
});
export type FramingSettings = z.infer<typeof framingSchema>;

export const AR_OBJECT_KINDS = ["emoji", "text", "image", "model"] as const;
export const arObjectSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(60),
    kind: z.enum(AR_OBJECT_KINDS),
    /** Emoji glyph, text, an image data URL, or a pet/model id. */
    content: z.string().max(400_000),
    visible: z.boolean().default(true),
    /** Output-normalised position 0..1 (y down). */
    x: z.number().min(-0.5).max(1.5),
    y: z.number().min(-0.5).max(1.5),
    /** Metres from the camera; the person walks in front of / behind it. */
    z: z.number().min(0.3).max(6),
    /** Height in metres at its depth. */
    size: z.number().min(0.02).max(3).default(0.3),
    rotation: z.number().min(-180).max(180).default(0),
    /** Turn slowly / bob for life. */
    animate: z.enum(["none", "spin", "bob", "pulse"]).default("bob"),
    /** Pin to a body anchor instead of the world. */
    anchor: z.enum(["world", "head", "leftShoulder", "rightShoulder", "leftHand", "rightHand"]).default("world"),
});
export type ArObject = z.infer<typeof arObjectSchema>;

/** Rolling clip buffer of the studio OUTPUT (what viewers see), H.264 via WebCodecs (decision Q50). */
export const clipsSchema = z.object({
    enabled: z.boolean().default(true),
    /** Seconds kept in the rolling buffer. */
    seconds: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
    /** Target H.264 bitrate; RAM ≈ bitrate × seconds (8 Mbps × 30 s ≈ 30 MB). */
    bitrateMbps: z.union([z.literal(4), z.literal(8), z.literal(12)]).default(8),
    /** Every highlight (hotkey, Live Control, rule) also saves a clip. */
    saveOnHighlight: z.boolean().default(true),
});
export type ClipSettings = z.infer<typeof clipsSchema>;

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
    /** Feed the composited frame to the native "TikSee Camera" (WS25-01). */
    virtualCamera: z.boolean().default(true),
    /** 30 or 60 fps virtual-camera output. */
    virtualCameraFps: z.union([z.literal(30), z.literal(60)]).default(60),
    /** Preview-only monitoring aids; never in the output frame. */
    monitor: monitorSchema.prefault({}),
    /** Digital framing: zoom, auto-reframe on the face, synthetic depth of field. */
    framing: framingSchema.prefault({}),
    /** Placed AR objects (x/y in output 0..1, z in metres from the camera). */
    arObjects: z.array(arObjectSchema).max(32).default([]),
    /** Rolling clip buffer (WS28-07). */
    clips: clipsSchema.prefault({}),
});
export type StudioSettings = z.infer<typeof studioSchema>;

/* ------------------------------------------------------------------ *
 * Vision: gestures, expressions, posture, identity, depth (0.3.0).
 * ------------------------------------------------------------------ */

export const DEPTH_MODES = ["bodyScale", "model"] as const;
export type DepthMode = (typeof DEPTH_MODES)[number];

export const calibrationSchema = z.object({
    /** Per-eye blink thresholds from the calibration wizard (0..1 blendshape). */
    blinkLeft: z.number().min(0.1).max(0.95).default(0.5),
    blinkRight: z.number().min(0.1).max(0.95).default(0.5),
    smile: z.number().min(0.1).max(0.95).default(0.6),
    mouthOpen: z.number().min(0.1).max(0.95).default(0.45),
    browsUp: z.number().min(0.1).max(0.95).default(0.55),
    /** Shoulder width in output px and inter-pupil distance at `referenceM`. */
    shoulderPx: z.number().min(0).default(0),
    ipdPx: z.number().min(0).default(0),
    referenceM: z.number().min(0.3).max(4).default(1),
    /** Upright posture baseline: nose-to-shoulder-line distance as a fraction of shoulder width. */
    neckRatio: z.number().min(0).default(0),
    /** Image-left blendshape is the subject's right eye when the feed is mirrored; the wizard confirms. */
    swapEyes: z.boolean().default(false),
    calibratedAt: z.number().int().default(0),
});
export type VisionCalibration = z.infer<typeof calibrationSchema>;

export const visionSchema = z.object({
    enabled: z.boolean().default(true),
    /** Families the detectors run for; off = model not loaded at all. */
    families: z
        .record(z.enum(SIGNAL_FAMILIES), z.boolean())
        .default({ hand: true, twoHands: true, motion: true, face: true, posture: true, state: true, presence: true }),
    /** Up to this many hands / faces / poses tracked. */
    maxPeople: z.number().int().min(1).max(4).default(2),
    /** Global gate for every signal-driven rule. */
    rulesEnabled: z.boolean().default(true),
    /** Sensitive rules need an arm (open palm hold) within this window. */
    armHoldMs: z.number().int().min(300).max(3000).default(1000),
    armWindowMs: z.number().int().min(1000).max(30_000).default(5000),
    /** Show the recognised gesture with a hold ring in the studio preview. */
    showGestureHud: z.boolean().default(true),
    /** Keep a timeline of state changes and durations in SQLite. */
    logEnabled: z.boolean().default(true),
    logRetentionDays: z.number().int().min(1).max(365).default(30),
    depth: z.enum(DEPTH_MODES).default("bodyScale"),
    /** Enrolled-identity matching (beta, models downloaded on demand). */
    identity: z.boolean().default(false),
    /** Coaching nudges, all preview-only. */
    coach: z
        .object({
            eyeContact: z.boolean().default(true),
            posture: z.boolean().default(true),
            hydrationMin: z.number().int().min(0).max(240).default(45),
            exposure: z.boolean().default(true),
            safeZones: z.boolean().default(true),
            energy: z.boolean().default(true),
        })
        .prefault({}),
    calibration: calibrationSchema.prefault({}),
    rules: z.array(ruleSchema).max(200).default(defaultRules),
    tutorialDone: z.boolean().default(false),
});
export type VisionSettings = z.infer<typeof visionSchema>;

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
    vision: visionSchema.prefault({}),
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
