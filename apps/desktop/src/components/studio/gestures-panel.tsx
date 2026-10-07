import {
    AR_EFFECTS,
    CAMERA_ACTIONS,
    CONTROL_ACTIONS,
    MOMENTARY_SIGNALS,
    PET_REACTIONS,
    SIGNAL_FAMILIES,
    STUDIO_ACTIONS,
    type Rule,
    type RuleAction,
    type SignalId,
    type Trigger,
} from "@tiksee/core";
import { SliderRow, SwitchRow } from "@tiksee/ui";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Play, Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { blankRule, defaultAction, defaultTrigger, signalsByFamily, uniqueRuleId, SIGNAL_EMOJI } from "../../lib/vision/catalog.js";
import { useVisionLabels } from "../../lib/vision/labels.js";
import { FOCUS_RING, INSTANT, SPRING, useStudio } from "./context.js";
import { Section } from "./controls-parts.js";

/** Actions the quick editor offers: the studio "do" set plus a highlight. */
const QUICK_ACTIONS = ["effect", "pet", "camera", "studio", "control", "highlight"] as const;
type QuickAction = (typeof QUICK_ACTIONS)[number];

const SELECT = `w-full rounded-xl border border-white/15 bg-neutral-900/85 px-2.5 py-1.5 text-xs text-white ${FOCUS_RING}`;

/** A rule the quick editor can edit fully: one signal trigger, one plain action, no condition. */
function isSimple(r: Rule): boolean {
    const a = r.actions[0];
    return r.triggers.length === 1 && r.triggers[0]?.type === "signal" && r.actions.length === 1 && !!a && (QUICK_ACTIONS as readonly string[]).includes(a.type) && !r.when;
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
    const id = useId();
    return (
        <div className="space-y-1">
            <label htmlFor={id} className="block text-[0.75rem] text-white/80">
                {label}
            </label>
            {children(id)}
        </div>
    );
}

/** Signal picker: native select with family groups and emoji (keyboard + screen reader for free). */
function SignalSelect({ value, onChange }: { value: SignalId; onChange: (s: SignalId) => void }) {
    const { t } = useTranslation();
    const groups = useMemo(() => signalsByFamily(), []);
    return (
        <Field label={t("studio.gestures.gesture")}>
            {(id) => (
                <select id={id} value={value} onChange={(e) => onChange(e.target.value as SignalId)} className={SELECT}>
                    {SIGNAL_FAMILIES.map((f) => (
                        <optgroup key={f} label={t(`vision.families.${f}`)}>
                            {groups[f].map((s) => (
                                <option key={s} value={s}>
                                    {SIGNAL_EMOJI[s]} {t(`vision.signals.${s}`)}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            )}
        </Field>
    );
}

function EnumSelect<T extends string>({ label, value, options, ns, onChange }: { label: string; value: T; options: readonly T[]; ns: string; onChange: (v: T) => void }) {
    const { t } = useTranslation();
    return (
        <Field label={label}>
            {(id) => (
                <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={SELECT}>
                    {options.map((o) => (
                        <option key={o} value={o}>
                            {t(`${ns}.${o}`)}
                        </option>
                    ))}
                </select>
            )}
        </Field>
    );
}

/** The detail of the plain action (effect, pet reaction, camera, studio, control). */
function ActionDetail({ action, onChange }: { action: RuleAction; onChange: (a: RuleAction) => void }) {
    const { t } = useTranslation();
    switch (action.type) {
        case "effect":
            return <EnumSelect label={t("studio.gestures.effect")} value={action.effect} options={AR_EFFECTS} ns="vision.effects" onChange={(effect) => onChange({ ...action, effect })} />;
        case "pet":
            return <EnumSelect label={t("studio.gestures.petReaction")} value={action.reaction} options={PET_REACTIONS} ns="vision.petReactions" onChange={(reaction) => onChange({ ...action, reaction })} />;
        case "camera":
            return <EnumSelect label={t("studio.gestures.camera")} value={action.action} options={CAMERA_ACTIONS} ns="vision.cameraActions" onChange={(a) => onChange({ ...action, action: a })} />;
        case "studio":
            return <EnumSelect label={t("studio.gestures.studio")} value={action.action} options={STUDIO_ACTIONS} ns="vision.studioActions" onChange={(a) => onChange({ ...action, action: a })} />;
        case "control":
            return <EnumSelect label={t("studio.gestures.control")} value={action.action} options={CONTROL_ACTIONS} ns="vision.controlActions" onChange={(a) => onChange({ ...action, action: a })} />;
        default:
            return null;
    }
}

function RuleEditor({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
    const { t } = useTranslation();
    const trigger = rule.triggers[0] as Extract<Trigger, { type: "signal" }>;
    const action = rule.actions[0] as RuleAction;
    const momentary = MOMENTARY_SIGNALS.has(trigger.signal);
    const setTrigger = (p: Partial<Extract<Trigger, { type: "signal" }>>) => onChange({ ...rule, triggers: [{ ...trigger, ...p }] });
    return (
        <div className="space-y-3">
            <SignalSelect value={trigger.signal} onChange={(signal) => setTrigger({ signal, ...(MOMENTARY_SIGNALS.has(signal) ? { on: "start" as const, holdMs: 0 } : {}) })} />
            {!momentary && (
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1" role="radiogroup" aria-label={t("studio.gestures.when")}>
                    {(["start", "hold"] as const).map((on) => (
                        <button
                            key={on}
                            type="button"
                            role="radio"
                            aria-checked={trigger.on === on}
                            onClick={() => setTrigger({ on, holdMs: on === "hold" ? Math.max(trigger.holdMs, 500) : 0 })}
                            className={`rounded-lg px-2 py-1 text-[0.75rem] transition-colors ${FOCUS_RING} ${trigger.on === on ? "bg-white text-neutral-900" : "text-white hover:bg-white/10"}`}
                        >
                            {t(`studio.gestures.on.${on}`)}
                        </button>
                    ))}
                </div>
            )}
            {!momentary && trigger.on === "hold" && (
                <SliderRow label={t("studio.gestures.holdFor")} value={trigger.holdMs} min={200} max={3000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(holdMs) => setTrigger({ holdMs: Math.round(holdMs) })} />
            )}
            <EnumSelect
                label={t("studio.gestures.action")}
                value={action.type as QuickAction}
                options={QUICK_ACTIONS}
                ns="vision.actionTypes"
                onChange={(type) => onChange({ ...rule, actions: [defaultAction(type)] })}
            />
            <ActionDetail action={action} onChange={(a) => onChange({ ...rule, actions: [a] })} />
            <SliderRow label={t("studio.gestures.cooldown")} value={rule.cooldownMs} min={0} max={10000} step={250} format={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(cooldownMs) => onChange({ ...rule, cooldownMs: Math.round(cooldownMs) })} />
            <SwitchRow label={t("studio.gestures.arm")} description={t("studio.gestures.armHint")} checked={rule.requiresArm} onChange={(requiresArm) => onChange({ ...rule, requiresArm })} />
        </div>
    );
}

/**
 * Studio dock Gestures panel (lazy chunk): every rule with its on/off switch, what triggers it
 * and what it does; simple rules (one gesture -> one action) are fully editable here, others
 * show read-only with a hint to edit them in the app. Add, test and delete rules. Changes go
 * through patchVision (applied live, persisted, synced to the sidecar's rule engine).
 */
export function GesturesPanel() {
    const { vision, patchVision, studio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const labels = useVisionLabels();
    const [open, setOpen] = useState<string | null>(null);
    const rules = vision.rules;
    const setRules = (next: Rule[]) => patchVision({ rules: next });
    const update = (r: Rule) => setRules(rules.map((x) => (x.id === r.id ? r : x)));
    const gz = vision.gestureZones;
    const zoneIds = studio.orientation === "portrait" ? (["top", "comments", "rail", "bottom", "crop"] as const) : (["title"] as const);
    const setZones = (p: Partial<typeof gz>) => patchVision({ gestureZones: { ...gz, ...p } });

    const add = () => {
        const name = t("studio.gestures.newName");
        const id = uniqueRuleId(name, rules.map((r) => r.id));
        const r = { ...blankRule(id, name), triggers: [defaultTrigger("signal")] };
        setRules([r, ...rules]);
        setOpen(id);
    };

    return (
        <>
            <Section title={t("studio.gestures.title")}>
                <SwitchRow label={t("studio.gestures.enabled")} description={t("studio.gestures.enabledHint")} checked={vision.rulesEnabled} onChange={(rulesEnabled) => patchVision({ rulesEnabled })} />
                <button type="button" onClick={add} className={`flex w-full items-center justify-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium hover:bg-white/20 ${FOCUS_RING}`}>
                    <Plus className="size-4" aria-hidden />
                    {t("studio.gestures.add")}
                </button>
            </Section>
            <Section title={t("studio.gestures.zones.title")}>
                <SwitchRow label={t("studio.gestures.zones.enabled")} description={t("studio.gestures.zones.hint")} checked={gz.enabled} onChange={(enabled) => setZones({ enabled })} />
                {gz.enabled && (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("studio.gestures.zones.which")}>
                        {zoneIds.map((id) => (
                            <button
                                key={id}
                                type="button"
                                aria-pressed={gz.zones[id]}
                                onClick={() => setZones({ zones: { ...gz.zones, [id]: !gz.zones[id] } })}
                                className={`rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${FOCUS_RING} ${gz.zones[id] ? "bg-rose-400/30 text-rose-50 ring-1 ring-rose-300/60" : "bg-white/10 text-white/80 hover:bg-white/20"}`}
                            >
                                {t(`studio.gestures.zones.ids.${id}`)}
                            </button>
                        ))}
                    </div>
                )}
            </Section>
            <ul className="space-y-1.5" aria-label={t("studio.gestures.list")}>
                {rules.map((r) => {
                    const simple = isSimple(r);
                    const expanded = open === r.id;
                    const trig = r.triggers.map((tr) => labels.trigger(tr)).join(" · ");
                    const acts = r.actions.map((a) => labels.action(a)).join(" · ");
                    return (
                        <motion.li key={r.id} layout={!reduced} transition={reduced ? INSTANT : SPRING} className={`overflow-hidden rounded-2xl ${expanded ? "bg-white/10 ring-1 ring-sky-300/40" : "bg-white/5"}`}>
                            <div className="flex items-center gap-2 px-2.5 py-2">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={r.enabled}
                                    aria-label={t("studio.gestures.toggle", { name: r.name })}
                                    onClick={() => update({ ...r, enabled: !r.enabled })}
                                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${FOCUS_RING} ${r.enabled ? "bg-sky-400" : "bg-white/20"}`}
                                >
                                    <motion.span className="absolute top-0.5 size-4 rounded-full bg-white shadow" animate={{ left: r.enabled ? 18 : 2 }} transition={reduced ? INSTANT : SPRING} />
                                </button>
                                <button type="button" onClick={() => setOpen(expanded ? null : r.id)} aria-expanded={expanded} className={`min-w-0 flex-1 text-left ${FOCUS_RING} rounded-lg`}>
                                    <span className="block truncate text-xs font-semibold">{r.name}</span>
                                    <span className="block truncate text-[0.6875rem] text-white/75">
                                        {trig} → {acts}
                                    </span>
                                </button>
                                {r.requiresArm && <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 text-[0.625rem] text-amber-100">{t("studio.gestures.armed")}</span>}
                                <ChevronDown className={`size-4 shrink-0 text-white/70 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                            </div>
                            <AnimatePresence initial={false}>
                                {expanded && (
                                    <motion.div
                                        initial={reduced ? false : { height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                        transition={reduced ? INSTANT : SPRING}
                                        className="overflow-hidden"
                                    >
                                        <div className="space-y-3 border-t border-white/10 px-2.5 py-3">
                                            <Field label={t("studio.gestures.name")}>
                                                {(id) => (
                                                    <input
                                                        id={id}
                                                        value={r.name}
                                                        maxLength={80}
                                                        onChange={(e) => {
                                                            if (e.target.value.trim()) update({ ...r, name: e.target.value });
                                                        }}
                                                        className={SELECT}
                                                    />
                                                )}
                                            </Field>
                                            {simple ? <RuleEditor rule={r} onChange={update} /> : <p className="rounded-xl bg-white/5 px-2.5 py-2 text-[0.6875rem] text-white/75">{t("studio.gestures.complex")}</p>}
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        sidecarClient.send({ type: "ruleTest", ruleId: r.id });
                                                        toast(t("studio.gestures.tested", { name: r.name }));
                                                    }}
                                                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 ${FOCUS_RING}`}
                                                >
                                                    <Play className="size-3.5" aria-hidden />
                                                    {t("studio.gestures.test")}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setRules(rules.filter((x) => x.id !== r.id));
                                                        setOpen(null);
                                                    }}
                                                    aria-label={t("studio.gestures.delete", { name: r.name })}
                                                    className={`grid size-8 place-items-center rounded-xl bg-white/10 hover:bg-rose-500/30 ${FOCUS_RING}`}
                                                >
                                                    <Trash2 className="size-3.5" aria-hidden />
                                                </button>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.li>
                    );
                })}
            </ul>
        </>
    );
}
