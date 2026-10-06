import {
    AR_EFFECTS,
    CAMERA_ACTIONS,
    CONTROL_ACTIONS,
    PET_REACTIONS,
    SIGNAL_FAMILIES,
    SIGNAL_IDS,
    STUDIO_ACTIONS,
    signalFamily,
    type Condition,
    type Rule,
    type RuleAction,
    type RuleVar,
    type SignalFamily,
    type SignalId,
    type Trigger,
} from "@tiksee/core";

/** Glyph shown next to every signal in pickers, chips and the signals grid. */
export const SIGNAL_EMOJI: Record<SignalId, string> = {
    thumb_up: "👍",
    thumb_down: "👎",
    open_palm: "✋",
    fist: "✊",
    victory: "✌️",
    i_love_you: "🤟",
    point_up: "☝️",
    point_left: "👈",
    point_right: "👉",
    ok: "👌",
    rock: "🤘",
    pinch: "🤏",
    call_me: "🤙",
    fingers_0: "0️⃣",
    fingers_1: "1️⃣",
    fingers_2: "2️⃣",
    fingers_3: "3️⃣",
    fingers_4: "4️⃣",
    fingers_5: "5️⃣",
    heart: "🫶",
    frame: "🖼️",
    timeout: "⏱️",
    prayer: "🙏",
    clap: "👏",
    spread: "↔️",
    squeeze: "🤲",
    swipe_left: "⬅️",
    swipe_right: "➡️",
    swipe_up: "⬆️",
    swipe_down: "⬇️",
    circle: "🔄",
    wave: "👋",
    wink_left: "😉",
    wink_right: "😉",
    blink_double: "😌",
    eyes_closed: "😑",
    smile: "😊",
    mouth_open: "😮",
    brows_up: "🤨",
    pucker: "😗",
    tongue_out: "😛",
    cheek_puff: "🐡",
    nod: "🙆",
    shake: "🙅",
    tilt_left: "↖️",
    tilt_right: "↗️",
    look_away: "👀",
    eye_contact: "👁️",
    lean_in: "🔎",
    lean_out: "🔭",
    slouch: "😩",
    standing: "🧍",
    sitting: "🪑",
    arms_crossed: "💪",
    hand_raised: "🙋",
    hands_on_head: "🤯",
    away: "🚶",
    talking: "🗣️",
    laughing: "😂",
    drinking: "🥤",
    eating: "🍽️",
    phone: "📱",
    energy_high: "⚡",
    energy_low: "🔋",
    person_enter: "🚪",
    person_leave: "🏃",
    dog_enter: "🐕",
    dog_leave: "🐾",
    owner_present: "⭐",
};

export type ActionType = RuleAction["type"];

export const ACTION_EMOJI: Record<ActionType, string> = {
    control: "🎛️",
    camera: "📷",
    studio: "🎬",
    effect: "✨",
    arObject: "🧊",
    pet: "🦜",
    speak: "🗣️",
    vmuiFlash: "💡",
    vmuiScene: "🌈",
    highlight: "⭐",
    notify: "🔔",
    set: "🔢",
    if: "🔀",
    wait: "⏳",
    repeat: "🔁",
    parallel: "⇉",
    stop: "⛔",
};

/** The add-action menu, grouped for scanning. */
export const ACTION_CATEGORIES: ReadonlyArray<{ id: "do" | "sayShow" | "logic"; types: readonly ActionType[] }> = [
    { id: "do", types: ["control", "camera", "studio", "effect", "arObject", "pet"] },
    { id: "sayShow", types: ["speak", "vmuiFlash", "vmuiScene", "highlight", "notify"] },
    { id: "logic", types: ["set", "if", "wait", "repeat", "parallel", "stop"] },
];

export const TRIGGER_TYPES = ["signal", "chat", "gift", "follow", "control", "timer", "manual"] as const;
export type TriggerType = Trigger["type"];

/** Variables that hold booleans get a true/false picker instead of a number. */
export const BOOLEAN_VARS: ReadonlySet<RuleVar> = new Set<RuleVar>([
    "live.connected",
    "control.muted",
    "control.repliesPaused",
    "control.effectsOff",
    "control.shopMode",
    "control.petsHidden",
    "vision.armed",
    "vision.ownerPresent",
]);

/** i18n key for a rule variable (`live.viewers` -> `live_viewers`; i18next splits on dots). */
export const varKey = (v: RuleVar): string => v.replace(/\./g, "_");

export function signalsByFamily(): Record<SignalFamily, SignalId[]> {
    const out = Object.fromEntries(SIGNAL_FAMILIES.map((f) => [f, [] as SignalId[]])) as Record<SignalFamily, SignalId[]>;
    for (const id of SIGNAL_IDS) out[signalFamily(id)].push(id);
    return out;
}

export function defaultTrigger(type: TriggerType): Trigger {
    switch (type) {
        case "signal":
            return { type, signal: "thumb_up", on: "start", holdMs: 0, minConfidence: 0.6, who: "owner" };
        case "chat":
            return { type, contains: "!" };
        case "gift":
            return { type, minDiamonds: 1 };
        case "follow":
            return { type };
        case "control":
            return { type, action: "highlight" };
        case "timer":
            return { type, everyMs: 60_000 };
        case "manual":
            return { type };
    }
}

export function defaultCondition(type: Condition["type"]): Condition {
    switch (type) {
        case "all":
        case "any":
            return { type, of: [] };
        case "not":
            return { type, of: { type: "compare", var: "vision.armed", op: "eq", value: true } };
        case "compare":
            return { type, var: "live.viewers", op: "gt", value: 10 };
        case "signalActive":
            return { type, signal: "smile", who: "owner" };
    }
}

export function defaultAction(type: ActionType): RuleAction {
    switch (type) {
        case "control":
            return { type, action: CONTROL_ACTIONS[0] };
        case "camera":
            return { type, action: CAMERA_ACTIONS[0] };
        case "studio":
            return { type, action: STUDIO_ACTIONS[0] };
        case "effect":
            return { type, effect: AR_EFFECTS[0] };
        case "arObject":
            return { type, objectId: "object", op: "toggle" };
        case "pet":
            return { type, reaction: PET_REACTIONS[0] };
        case "speak":
            return { type, text: "Salut!" };
        case "vmuiFlash":
            return { type, color: "red" };
        case "vmuiScene":
            return { type, scene: "party" };
        case "highlight":
            return { type };
        case "notify":
            return { type, text: "Hey!" };
        case "set":
            return { type, var: "var.a", op: "inc", value: 1 };
        case "if":
            return { type, cond: { type: "compare", var: "var.a", op: "gt", value: 0 }, then: [], else: [] };
        case "wait":
            return { type, ms: 1000 };
        case "repeat":
            return { type, count: 2, do: [] };
        case "parallel":
            return { type, branches: [[], []] };
        case "stop":
            return { type };
    }
}

/** Signals a condition reads (`signalActive`), recursively. */
export function conditionSignals(cond: Condition | undefined, into = new Set<SignalId>()): Set<SignalId> {
    if (!cond) return into;
    switch (cond.type) {
        case "all":
        case "any":
            for (const c of cond.of) conditionSignals(c, into);
            break;
        case "not":
            conditionSignals(cond.of, into);
            break;
        case "signalActive":
            into.add(cond.signal);
            break;
        case "compare":
            break;
    }
    return into;
}

function actionSignals(actions: readonly RuleAction[], into: Set<SignalId>): void {
    for (const a of actions) {
        if (a.type === "if") {
            conditionSignals(a.cond, into);
            actionSignals(a.then, into);
            actionSignals(a.else, into);
        } else if (a.type === "repeat") actionSignals(a.do, into);
        else if (a.type === "parallel") for (const b of a.branches) actionSignals(b, into);
    }
}

/** Every signal a rule depends on: its triggers, its guard and any if/else condition. */
export function signalsUsed(rule: Rule): Set<SignalId> {
    const out = new Set<SignalId>();
    for (const t of rule.triggers) if (t.type === "signal") out.add(t.signal);
    conditionSignals(rule.when, out);
    actionSignals(rule.actions, out);
    return out;
}

export function rulesBySignal(rules: readonly Rule[]): Map<SignalId, Rule[]> {
    const out = new Map<SignalId, Rule[]>();
    for (const rule of rules) {
        for (const s of signalsUsed(rule)) {
            const list = out.get(s) ?? [];
            list.push(rule);
            out.set(s, list);
        }
    }
    return out;
}

/** Counts actions in a tree, nested ones included. */
export function countActions(actions: readonly RuleAction[]): number {
    let n = 0;
    for (const a of actions) {
        n++;
        if (a.type === "if") n += countActions(a.then) + countActions(a.else);
        else if (a.type === "repeat") n += countActions(a.do);
        else if (a.type === "parallel") for (const b of a.branches) n += countActions(b);
    }
    return n;
}

export function uniqueRuleId(base: string, taken: Iterable<string>): string {
    const set = new Set(taken);
    const slug =
        base
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "rule";
    if (!set.has(slug)) return slug;
    for (let i = 2; ; i++) {
        const id = `${slug}-${i}`;
        if (!set.has(id)) return id;
    }
}

export function blankRule(id: string, name: string): Rule {
    return {
        id,
        name,
        enabled: true,
        requiresArm: false,
        mode: "single",
        cooldownMs: 1500,
        triggers: [defaultTrigger("signal")],
        actions: [defaultAction("effect")],
        ui: { graph: {} },
    };
}

export function duplicateRule(rule: Rule, name: string, taken: Iterable<string>): Rule {
    const copy = structuredClone(rule);
    return { ...copy, id: uniqueRuleId(`${rule.id}-copy`, taken), name: name.slice(0, 80) };
}

/** Returns a copy with item `from` moved to `to` (clamped); same array when out of range. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    if (from < 0 || from >= list.length) return [...list];
    const target = Math.max(0, Math.min(list.length - 1, to));
    const next = [...list];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(target, 0, item);
    return next;
}

/** Path of a zod issue as the dotted key the editors use for inline errors. */
export const issueKey = (path: ReadonlyArray<PropertyKey>): string => path.map(String).join(".");
