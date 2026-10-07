import { z } from "zod";

import { CONTROL_ACTIONS } from "./live.js";

/**
 * Vision contract (0.3.0): what the studio sees, how it is logged, and the
 * rules that turn signals into actions.
 *
 * Ownership: the studio window runs every model (MediaPipe + ONNX) and emits
 * debounced *signal edges*; the sidecar owns the rules engine, the vision log
 * and the enrolled identities (SQLite). Actions the sidecar cannot perform
 * itself (camera over BLE, studio look, AR objects, pets) go back to the
 * studio as `ruleAction` messages.
 */

/* ------------------------------------------------------------------ *
 * Signals.
 * ------------------------------------------------------------------ */

/** Static hand shapes, per hand. `fingers_N` = N extended fingers. */
export const HAND_GESTURES = [
    "thumb_up",
    "thumb_down",
    "open_palm",
    "fist",
    "victory",
    "i_love_you",
    "point_up",
    "point_left",
    "point_right",
    "ok",
    "rock",
    "pinch",
    "call_me",
    "fingers_0",
    "fingers_1",
    "fingers_2",
    "fingers_3",
    "fingers_4",
    "fingers_5",
] as const;
export type HandGesture = (typeof HAND_GESTURES)[number];

export const TWO_HAND_GESTURES = ["heart", "frame", "timeout", "prayer", "clap", "spread", "squeeze"] as const;
export const MOTION_GESTURES = ["swipe_left", "swipe_right", "swipe_up", "swipe_down", "circle", "wave"] as const;
export const FACE_SIGNALS = [
    "wink_left",
    "wink_right",
    "blink_double",
    "eyes_closed",
    "smile",
    "mouth_open",
    "brows_up",
    "pucker",
    "tongue_out",
    "cheek_puff",
    "nod",
    "shake",
    "tilt_left",
    "tilt_right",
    "look_away",
    "eye_contact",
] as const;
export const POSTURE_SIGNALS = [
    "lean_in",
    "lean_out",
    "slouch",
    "standing",
    "sitting",
    "arms_crossed",
    "hand_raised",
    "hands_on_head",
    "away",
] as const;
export const STATE_SIGNALS = ["talking", "laughing", "drinking", "eating", "phone", "energy_high", "energy_low"] as const;
export const PRESENCE_SIGNALS = ["person_enter", "person_leave", "dog_enter", "dog_leave", "owner_present"] as const;

export const SIGNAL_IDS = [
    ...HAND_GESTURES,
    ...TWO_HAND_GESTURES,
    ...MOTION_GESTURES,
    ...FACE_SIGNALS,
    ...POSTURE_SIGNALS,
    ...STATE_SIGNALS,
    ...PRESENCE_SIGNALS,
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];
export const signalIdSchema = z.enum(SIGNAL_IDS);

/** Signal families, for the settings UI and per-family toggles. */
export const SIGNAL_FAMILIES = ["hand", "twoHands", "motion", "face", "posture", "state", "presence"] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];
export function signalFamily(id: SignalId): SignalFamily {
    if ((HAND_GESTURES as readonly string[]).includes(id)) return "hand";
    if ((TWO_HAND_GESTURES as readonly string[]).includes(id)) return "twoHands";
    if ((MOTION_GESTURES as readonly string[]).includes(id)) return "motion";
    if ((FACE_SIGNALS as readonly string[]).includes(id)) return "face";
    if ((POSTURE_SIGNALS as readonly string[]).includes(id)) return "posture";
    if ((STATE_SIGNALS as readonly string[]).includes(id)) return "state";
    return "presence";
}

/** Momentary signals have no duration (they fire once); the rest have start/end edges. */
export const MOMENTARY_SIGNALS: ReadonlySet<SignalId> = new Set<SignalId>([
    ...MOTION_GESTURES,
    "wink_left",
    "wink_right",
    "blink_double",
    "nod",
    "shake",
    "clap",
    "person_enter",
    "person_leave",
    "dog_enter",
    "dog_leave",
]);

export const SUBJECT_KINDS = ["person", "dog"] as const;
export const subjectSchema = z.object({
    kind: z.enum(SUBJECT_KINDS),
    /** Per-session track id from the studio's multi-subject tracker. */
    track: z.number().int().min(0),
    /** Enrolled identity, when matched. */
    profileId: z.string().optional(),
    name: z.string().optional(),
    /** True when this subject is the owner profile. */
    owner: z.boolean().default(false),
});
export type Subject = z.infer<typeof subjectSchema>;

export const SIGNAL_PHASES = ["start", "end", "pulse"] as const;
export type SignalPhase = (typeof SIGNAL_PHASES)[number];

export const signalEventSchema = z.object({
    signal: signalIdSchema,
    phase: z.enum(SIGNAL_PHASES),
    /** Epoch ms. */
    at: z.number().int(),
    confidence: z.number().min(0).max(1),
    /** Set on `end`: how long the state lasted. */
    durationMs: z.number().int().min(0).optional(),
    subject: subjectSchema,
    /** `left`/`right` hand, when the signal is single-handed. */
    hand: z.enum(["left", "right"]).optional(),
    /** Optional scalar (finger count, swipe speed, energy 0..1). */
    value: z.number().optional(),
});
export type SignalEvent = z.infer<typeof signalEventSchema>;

/** Rolling snapshot the studio pushes ~2 Hz, for the HUD and the vision log. */
export const visionSnapshotSchema = z.object({
    at: z.number().int(),
    subjects: z.array(
        subjectSchema.extend({
            /** Estimated distance from the camera in metres (calibrated body scale or depth model). */
            distanceM: z.number().optional(),
            active: z.array(signalIdSchema),
            /** 0..1 */
            energy: z.number().min(0).max(1).optional(),
        }),
    ),
    perf: z.object({
        renderFps: z.number(),
        cameraFps: z.number(),
        visionMs: z.record(z.string(), z.number()),
        vcamFps: z.number().default(0),
    }),
});
export type VisionSnapshot = z.infer<typeof visionSnapshotSchema>;

/* ------------------------------------------------------------------ *
 * Identities (beta): only explicitly enrolled profiles are stored.
 * ------------------------------------------------------------------ */

export const PROFILE_KINDS = ["owner", "person", "dog"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const identityProfileSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(60),
    kind: z.enum(PROFILE_KINDS),
    /** Face (SFace 128-d) for people, DINOv2-S (384-d) for dogs; several per profile. */
    embeddings: z.array(z.array(z.number()).min(64).max(1024)).max(40),
    /** Free-form note shown in the people list (e.g. "the huge black one"). */
    note: z.string().max(200).default(""),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
});
export type IdentityProfile = z.infer<typeof identityProfileSchema>;

/** Seed names for the owner's dogs (decision 2026-10-05); enrolment still needs samples. */
export const SEED_DOGS = [
    { name: "Koro", note: "cel mai mic" },
    { name: "Kara", note: "fetița" },
    { name: "Kiri", note: "uriașul negru" },
] as const;

/* ------------------------------------------------------------------ *
 * Rules: triggers -> conditions -> actions (with if/else, wait, repeat).
 * One tree is the source of truth; the node graph is a projection (ui.graph).
 * ------------------------------------------------------------------ */

export const TRIGGER_KINDS = ["signal", "chat", "gift", "follow", "control", "timer", "manual"] as const;

export const triggerSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("signal"),
        signal: signalIdSchema,
        /** start = when it begins, end = when it ends, hold = after holdMs active. */
        on: z.enum(["start", "end", "hold"]).default("start"),
        holdMs: z.number().int().min(0).max(60_000).default(0),
        minConfidence: z.number().min(0).max(1).default(0.6),
        /** Restrict to a subject: owner, any person, a profile id, or any dog. */
        who: z.enum(["owner", "anyPerson", "anyDog", "anyone", "profile"]).default("owner"),
        profileId: z.string().optional(),
    }),
    z.object({ type: z.literal("chat"), contains: z.string().min(1).max(80) }),
    z.object({ type: z.literal("gift"), minDiamonds: z.number().int().min(0).default(1) }),
    z.object({ type: z.literal("follow") }),
    z.object({ type: z.literal("control"), action: z.enum(CONTROL_ACTIONS) }),
    z.object({ type: z.literal("timer"), everyMs: z.number().int().min(1000).max(3_600_000) }),
    z.object({ type: z.literal("manual") }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** Variables a condition may read; the sidecar resolves them at evaluation time. */
export const RULE_VARS = [
    "live.connected",
    "live.viewers",
    "control.muted",
    "control.repliesPaused",
    "control.effectsOff",
    "control.shopMode",
    "control.petsHidden",
    "vision.armed",
    "vision.people",
    "vision.dogs",
    "vision.ownerPresent",
    "vision.energy",
    "vision.distanceM",
    "trigger.confidence",
    "trigger.value",
    "trigger.durationMs",
    "lastGift.diamonds",
    "lastGift.ageMs",
    "time.hour",
    "rule.firedCount",
    "var.a",
    "var.b",
    "var.c",
] as const;
export type RuleVar = (typeof RULE_VARS)[number];
export const COMPARE_OPS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;

export type Condition =
    | { type: "all"; of: Condition[] }
    | { type: "any"; of: Condition[] }
    | { type: "not"; of: Condition }
    | { type: "compare"; var: RuleVar; op: (typeof COMPARE_OPS)[number]; value: number | boolean }
    | { type: "signalActive"; signal: SignalId; who: "owner" | "anyone" };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
    z.discriminatedUnion("type", [
        z.object({ type: z.literal("all"), of: z.array(conditionSchema).max(32) }),
        z.object({ type: z.literal("any"), of: z.array(conditionSchema).max(32) }),
        z.object({ type: z.literal("not"), of: conditionSchema }),
        z.object({
            type: z.literal("compare"),
            var: z.enum(RULE_VARS),
            op: z.enum(COMPARE_OPS),
            value: z.union([z.number(), z.boolean()]),
        }),
        z.object({ type: z.literal("signalActive"), signal: signalIdSchema, who: z.enum(["owner", "anyone"]) }),
    ]),
);

/** BLE remote actions on the camera (decision Q43: BLE is the live transport). */
export const CAMERA_ACTIONS = ["zoomIn", "zoomOut", "focusNear", "focusFar", "af", "photo", "record"] as const;
/** Studio-side look/framing actions. */
export const STUDIO_ACTIONS = [
    "digitalZoomIn",
    "digitalZoomOut",
    "digitalZoomReset",
    "reframeToggle",
    "dofToggle",
    "peakingToggle",
    "zebraToggle",
    "cleanFeedToggle",
    "loupeToggle",
    /** Write the rolling clip buffer to an MP4 (WS28-07). */
    "saveClip",
] as const;
export const AR_EFFECTS = ["hearts", "confetti", "sparkle", "kiss", "fire", "stars", "question", "wow", "countdown"] as const;
export const PET_REACTIONS = ["dance", "fly", "sleep", "look", "react"] as const;

export type RuleAction =
    | { type: "control"; action: (typeof CONTROL_ACTIONS)[number] }
    | { type: "camera"; action: (typeof CAMERA_ACTIONS)[number]; holdMs?: number }
    | { type: "studio"; action: (typeof STUDIO_ACTIONS)[number] }
    | { type: "effect"; effect: (typeof AR_EFFECTS)[number]; z?: number }
    | { type: "arObject"; objectId: string; op: "show" | "hide" | "toggle" }
    | { type: "pet"; reaction: (typeof PET_REACTIONS)[number] }
    | { type: "speak"; text: string }
    | { type: "vmuiFlash"; color: string }
    | { type: "vmuiScene"; scene: string }
    | { type: "highlight"; label?: string }
    | { type: "notify"; text: string }
    | { type: "set"; var: "var.a" | "var.b" | "var.c"; op: "set" | "inc" | "dec"; value: number }
    | { type: "if"; cond: Condition; then: RuleAction[]; else: RuleAction[] }
    | { type: "wait"; ms: number }
    | { type: "repeat"; count: number; do: RuleAction[] }
    | { type: "parallel"; branches: RuleAction[][] }
    | { type: "stop" };

const actionList = (): z.ZodType<RuleAction[]> => z.array(ruleActionSchema).max(64);

export const ruleActionSchema: z.ZodType<RuleAction> = z.lazy(() =>
    z.discriminatedUnion("type", [
        z.object({ type: z.literal("control"), action: z.enum(CONTROL_ACTIONS) }),
        z.object({
            type: z.literal("camera"),
            action: z.enum(CAMERA_ACTIONS),
            holdMs: z.number().int().min(50).max(5000).optional(),
        }),
        z.object({ type: z.literal("studio"), action: z.enum(STUDIO_ACTIONS) }),
        z.object({ type: z.literal("effect"), effect: z.enum(AR_EFFECTS), z: z.number().min(0.3).max(6).optional() }),
        z.object({ type: z.literal("arObject"), objectId: z.string().min(1).max(64), op: z.enum(["show", "hide", "toggle"]) }),
        z.object({ type: z.literal("pet"), reaction: z.enum(PET_REACTIONS) }),
        z.object({ type: z.literal("speak"), text: z.string().min(1).max(300) }),
        z.object({ type: z.literal("vmuiFlash"), color: z.string().min(1).max(32) }),
        z.object({ type: z.literal("vmuiScene"), scene: z.string().min(1).max(64) }),
        z.object({ type: z.literal("highlight"), label: z.string().max(60).optional() }),
        z.object({ type: z.literal("notify"), text: z.string().min(1).max(200) }),
        z.object({
            type: z.literal("set"),
            var: z.enum(["var.a", "var.b", "var.c"]),
            op: z.enum(["set", "inc", "dec"]),
            value: z.number(),
        }),
        z.object({ type: z.literal("if"), cond: conditionSchema, then: actionList(), else: actionList() }),
        z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(600_000) }),
        z.object({ type: z.literal("repeat"), count: z.number().int().min(1).max(50), do: actionList() }),
        z.object({ type: z.literal("parallel"), branches: z.array(actionList()).max(8) }),
        z.object({ type: z.literal("stop") }),
    ]),
);

/** Actions the studio window executes (the sidecar relays them as `ruleAction`). */
export const STUDIO_SIDE_ACTIONS = ["camera", "studio", "effect", "arObject", "pet"] as const;
export function isStudioSideAction(a: RuleAction): boolean {
    return (STUDIO_SIDE_ACTIONS as readonly string[]).includes(a.type);
}

export const RULE_MODES = ["single", "restart", "queued", "parallel"] as const;

export const ruleSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    /** Sensitive rules only fire while gestures are armed (open palm 1 s) or after a fist confirm. */
    requiresArm: z.boolean().default(false),
    mode: z.enum(RULE_MODES).default("single"),
    cooldownMs: z.number().int().min(0).max(3_600_000).default(1500),
    /** Triggers are OR'd. */
    triggers: z.array(triggerSchema).min(1).max(8),
    /** Optional guard; absent = always. */
    when: conditionSchema.optional(),
    actions: actionList(),
    /** Node-graph editor positions, keyed by node path ("t0", "a1.then.0", ...). */
    ui: z.object({ graph: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}) }).prefault({}),
});
export type Rule = z.infer<typeof ruleSchema>;

const sig = (signal: SignalId, extra: Partial<Extract<Trigger, { type: "signal" }>> = {}): Trigger => ({
    type: "signal",
    signal,
    on: "start",
    holdMs: 0,
    minConfidence: 0.6,
    who: "owner",
    ...extra,
});

/** Shipped defaults (research 2026-10-05): the high-value, low-risk set. */
export function defaultRules(): Rule[] {
    const r = (id: string, name: string, triggers: Trigger[], actions: RuleAction[], extra: Partial<Rule> = {}): Rule => ({
        id,
        name,
        enabled: true,
        requiresArm: false,
        mode: "single",
        cooldownMs: 2000,
        triggers,
        actions,
        ui: { graph: {} },
        ...extra,
    });
    return [
        r("wink-hearts", "Wink → hearts", [sig("wink_left"), sig("wink_right")], [{ type: "effect", effect: "hearts" }]),
        r("love-sparkle", "🤟 → sparkle + pets dance", [sig("i_love_you", { on: "hold", holdMs: 500 })], [
            { type: "effect", effect: "sparkle" },
            { type: "pet", reaction: "dance" },
        ]),
        r("thumb-thanks", "👍 → thank the last gifter", [sig("thumb_up", { on: "hold", holdMs: 400, minConfidence: 0.7 })], [
            {
                type: "if",
                cond: { type: "compare", var: "lastGift.ageMs", op: "lt", value: 60_000 },
                then: [{ type: "speak", text: "Mulțumesc mult pentru cadou!" }],
                else: [{ type: "effect", effect: "stars" }],
            },
        ], { cooldownMs: 10_000 }),
        r("thumb-skip", "👎 → skip current reply", [sig("thumb_down", { on: "hold", holdMs: 400, minConfidence: 0.7 })], [
            { type: "control", action: "skipCurrent" },
        ]),
        r("victory-photo", "✌ → 3-2-1 photo", [sig("victory", { on: "hold", holdMs: 500 })], [
            { type: "effect", effect: "countdown" },
            { type: "wait", ms: 3000 },
            { type: "camera", action: "photo" },
        ], { cooldownMs: 8000 }),
        r("heart-big", "🫶 → big hearts + pets", [sig("heart", { on: "hold", holdMs: 500 })], [
            { type: "effect", effect: "hearts", z: 1.2 },
            { type: "pet", reaction: "react" },
        ]),
        r("frame-highlight", "Frame gesture → highlight", [sig("frame", { on: "hold", holdMs: 600 })], [
            { type: "highlight", label: "frame" },
        ]),
        r("laugh-highlight", "Laughing → highlight", [sig("laughing", { on: "hold", holdMs: 1200 })], [
            { type: "highlight", label: "laugh" },
        ], { cooldownMs: 60_000 }),
        r("timeout-mute", "T timeout → mute/unmute co-host", [sig("timeout", { on: "hold", holdMs: 600 })], [
            {
                type: "if",
                cond: { type: "compare", var: "control.muted", op: "eq", value: true },
                then: [{ type: "control", action: "unmuteAssistant" }],
                else: [{ type: "control", action: "muteAssistant" }],
            },
        ], { requiresArm: true, cooldownMs: 3000 }),
        r("palm-pause", "✋ hold 1 s → pause/resume replies", [sig("open_palm", { on: "hold", holdMs: 1000 })], [
            {
                type: "if",
                cond: { type: "compare", var: "control.repliesPaused", op: "eq", value: true },
                then: [{ type: "control", action: "resumeReplies" }],
                else: [{ type: "control", action: "pauseReplies" }],
            },
        ], { enabled: false, cooldownMs: 3000 }),
        r("spread-zoom", "Two-hand spread → digital zoom in", [sig("spread")], [{ type: "studio", action: "digitalZoomIn" }], {
            cooldownMs: 600,
        }),
        r("squeeze-zoom", "Two-hand squeeze → digital zoom out", [sig("squeeze")], [{ type: "studio", action: "digitalZoomOut" }], {
            cooldownMs: 600,
        }),
        r("face-return-af", "Face back in frame → refocus", [sig("owner_present")], [{ type: "camera", action: "af" }], {
            cooldownMs: 5000,
        }),
        r("dog-cameo", "Dog appears → pets look + banner", [sig("dog_enter", { who: "anyDog" })], [
            { type: "pet", reaction: "look" },
            { type: "notify", text: "Dog on stream!" },
        ], { cooldownMs: 30_000 }),
        r("away-brb", "Away 3 s → pets sleep", [sig("away", { on: "hold", holdMs: 3000 })], [{ type: "pet", reaction: "sleep" }], {
            cooldownMs: 30_000,
        }),
        r("swipe-scene", "Swipe right → vmui party scene", [sig("swipe_right")], [{ type: "vmuiScene", scene: "party" }], {
            enabled: false,
            requiresArm: true,
        }),
    ];
}

/* ------------------------------------------------------------------ *
 * Vision log (SQLite in the sidecar): signal intervals with durations.
 * ------------------------------------------------------------------ */

export const visionLogEntrySchema = z.object({
    id: z.number().int(),
    signal: signalIdSchema,
    subjectName: z.string().optional(),
    subjectKind: z.enum(SUBJECT_KINDS),
    owner: z.boolean(),
    startedAt: z.number().int(),
    durationMs: z.number().int().min(0),
    confidence: z.number(),
    sessionId: z.number().int().optional(),
});
export type VisionLogEntry = z.infer<typeof visionLogEntrySchema>;

export const visionLogStatSchema = z.object({
    signal: signalIdSchema,
    count: z.number().int(),
    totalMs: z.number().int(),
    longestMs: z.number().int(),
});
export type VisionLogStat = z.infer<typeof visionLogStatSchema>;

export const ruleFiredSchema = z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    at: z.number().int(),
    trigger: z.string(),
    /** Why it did not run, when it was blocked (cooldown, not armed, condition false). */
    blocked: z.string().optional(),
    /** Flat trace of executed action types, e.g. ["if:then", "speak", "wait", "camera"]. */
    trace: z.array(z.string()).max(200),
});
export type RuleFired = z.infer<typeof ruleFiredSchema>;

/* ------------------------------------------------------------------ *
 * Pet director: the studio reports pet minds, the sidecar nudges them.
 * ------------------------------------------------------------------ */

/** Mirror of `ACTION_KINDS` in `@tiksee/pets` mind.ts (core cannot depend on pets). */
export const PET_ACTION_KINDS = [
    "perchShoulder",
    "perchHead",
    "landOnHand",
    "restOnLedge",
    "orbit",
    "watchOwner",
    "watchCohost",
    "visitPet",
    "playWithPet",
    "celebrate",
    "sleep",
    "inspectPoint",
    "greetViewers",
    "chatter",
] as const;
export type PetActionKind = (typeof PET_ACTION_KINDS)[number];

const unit = z.number().min(-1).max(1);

export const petMindStateSchema = z.object({
    pet: z.string().min(1).max(32),
    action: z.enum(PET_ACTION_KINDS).nullable(),
    needs: z.object({ energy: unit, curiosity: unit, attention: unit, affection: unit, play: unit }),
    mood: z.object({ valence: unit, arousal: unit }),
});
export type PetMindState = z.infer<typeof petMindStateSchema>;

export const petBiasSchema = z.object({
    /** A PetId present in the studio, or "all". */
    pet: z.string().min(1).max(32),
    action: z.enum(PET_ACTION_KINDS),
    /** Score multiplier: < 1 discourages, > 1 encourages. */
    k: z.number().min(0.3).max(2),
    ttlSec: z.number().min(2).max(60),
    why: z.string().max(120),
});
export type PetBias = z.infer<typeof petBiasSchema>;

/** Mirror of `ANCHORS` in `@tiksee/pets` roam.ts. */
export const PET_ANCHORS = ["shoulderL", "shoulderR", "crown", "handL", "handR", "ledgeL", "ledgeR", "orbit", "centre", "point"] as const;
export type PetAnchor = (typeof PET_ANCHORS)[number];
/** Clips the director may ask for (subset of the pet clip set). */
export const PET_COMMAND_CLIPS = ["wave", "dance", "happy", "look", "sleep", "talk", "idle"] as const;
export const PET_EMOTIONS = ["neutral", "happy", "excited", "curious", "sleepy", "shy", "proud", "sad"] as const;
export type PetEmotion = (typeof PET_EMOTIONS)[number];

/** OCEAN traits 0..1, per pet; drift slowly from experience (computed in code, never by the LLM). */
export const petTraitsSchema = z.object({
    openness: z.number().min(0).max(1),
    conscientiousness: z.number().min(0).max(1),
    extraversion: z.number().min(0).max(1),
    agreeableness: z.number().min(0).max(1),
    neuroticism: z.number().min(0).max(1),
});
export type PetTraits = z.infer<typeof petTraitsSchema>;

/** One remembered moment (importance 0..1); the newest/most important feed the pet agent. */
export const petMemorySchema = z.object({
    at: z.number().int(),
    text: z.string().min(1).max(160),
    importance: z.number().min(0).max(1),
});
export type PetMemory = z.infer<typeof petMemorySchema>;

/** Persistent per-pet personality (sidecar SQLite; reset from the studio). */
export const petPersonalitySchema = z.object({
    pet: z.string().min(1).max(32),
    traits: petTraitsSchema,
    /** Learned action preferences: multiplier per action (0.6..1.6), drift from what it enjoys. */
    likes: z.record(z.string(), z.number().min(0.6).max(1.6)),
    /** Short self-description the agent keeps consistent (written by code from traits, never by the LLM). */
    bio: z.string().max(240),
    memories: z.array(petMemorySchema).max(40),
    sessions: z.number().int().min(0),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
});
export type PetPersonality = z.infer<typeof petPersonalitySchema>;

/** Studio -> sidecar: what the owner did recently (for chatty pets), compact. */
export const petObservationSchema = z.object({
    at: z.number().int(),
    /** Signal id or interaction ("grabbed", "resized", "petted", "dropped"). */
    what: z.string().min(1).max(40),
    pet: z.string().max(32).optional(),
});
export type PetObservation = z.infer<typeof petObservationSchema>;

/** Sidecar -> studio: a pet says something (bubble in the output, optional TTS via `say`). */
export const petSaySchema = z.object({
    pet: z.string().min(1).max(32),
    text: z.string().min(1).max(120),
    emotion: z.enum(PET_EMOTIONS).default("neutral"),
    /** Bubble time on screen; the studio caps it from the text length. */
    ttlMs: z.number().int().min(1500).max(9000),
    /**
     * When voiced: the co-host queue entry id of this line. Its utterances arrive as `say` /
     * `speech` with id `<sayId>:<part>`; the studio lip-syncs only this pet for them.
     */
    sayId: z.string().optional(),
});
export type PetSay = z.infer<typeof petSaySchema>;

/** Sidecar -> studio (director level only): move a pet / play a clip; validated, TTL-bound. */
export const petCommandSchema = z.object({
    pet: z.string().min(1).max(32),
    anchor: z.enum(PET_ANCHORS).optional(),
    clip: z.enum(PET_COMMAND_CLIPS).optional(),
    ttlSec: z.number().min(2).max(30),
});
export type PetCommand = z.infer<typeof petCommandSchema>;

/* ------------------------------------------------------------------ *
 * Wire messages (merged into protocol.ts).
 * ------------------------------------------------------------------ */

export const visionClientMessages = [
    /** Batched signal edges from the studio (≤ 10 Hz). */
    z.object({ type: z.literal("visionSignals"), events: z.array(signalEventSchema).max(200) }),
    z.object({ type: z.literal("visionSnapshot"), snapshot: visionSnapshotSchema }),
    z.object({ type: z.literal("identityList") }),
    z.object({ type: z.literal("identityUpsert"), profile: identityProfileSchema }),
    z.object({ type: z.literal("identityDelete"), id: z.string().min(1).max(64) }),
    z.object({
        type: z.literal("visionLogQuery"),
        sinceMs: z.number().int().optional(),
        signal: signalIdSchema.optional(),
        limit: z.number().int().min(1).max(2000).default(500),
    }),
    z.object({ type: z.literal("visionLogClear") }),
    /** Run a rule now (editor "test" button), ignoring its triggers and cooldown. */
    z.object({ type: z.literal("ruleTest"), ruleId: z.string() }),
    /** Gesture arming state from the studio (open palm 1 s -> armed for armTimeoutMs). */
    z.object({ type: z.literal("visionArm"), armed: z.boolean() }),
    /** Pet minds from the studio (~every 5 s) for the optional LLM director. */
    z.object({
        type: z.literal("petState"),
        pets: z.array(petMindStateSchema).max(8),
        /** Recent owner/interaction observations since the last petState. */
        observations: z.array(petObservationSchema).max(20).default([]),
    }),
    /** A pet's mind chose to talk (sent at once, not on the 5 s petState tick). */
    z.object({ type: z.literal("petTalk"), pet: z.string().min(1).max(32) }),
    /** Ask for the stored personalities (answer: `petPersonalities`). */
    z.object({ type: z.literal("petPersonalityList") }),
    /** Forget one pet's personality and memories (or every pet with "all"). */
    z.object({ type: z.literal("petPersonalityReset"), pet: z.string().min(1).max(32) }),
] as const;

export const visionServerMessages = [
    /** Relayed to the studio: actions only the studio can perform. */
    z.object({ type: z.literal("ruleAction"), ruleId: z.string(), action: ruleActionSchema }),
    z.object({ type: z.literal("ruleFired"), fired: ruleFiredSchema }),
    z.object({ type: z.literal("identities"), profiles: z.array(identityProfileSchema) }),
    z.object({
        type: z.literal("visionLog"),
        entries: z.array(visionLogEntrySchema),
        stats: z.array(visionLogStatSchema),
    }),
    /** Latest studio snapshot, rebroadcast so the main window can show it. */
    z.object({ type: z.literal("visionSnapshot"), snapshot: visionSnapshotSchema }),
    /** Director nudge: multiply one pet action's utility for `ttlSec` (never a command). */
    z.object({ type: z.literal("petBias"), ...petBiasSchema.shape }),
    z.object({ type: z.literal("petSay"), ...petSaySchema.shape }),
    z.object({ type: z.literal("petCommand"), ...petCommandSchema.shape }),
    z.object({ type: z.literal("petPersonalities"), pets: z.array(petPersonalitySchema).max(16) }),
] as const;
