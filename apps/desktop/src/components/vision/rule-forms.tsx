import {
    AR_EFFECTS,
    CAMERA_ACTIONS,
    COMPARE_OPS,
    CONTROL_ACTIONS,
    PET_REACTIONS,
    RULE_VARS,
    STUDIO_ACTIONS,
    type Condition,
    type RuleAction,
    type RuleVar,
    type Trigger,
} from "@tiksee/core";
import { Button, cn } from "@tiksee/ui";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../store/app-store.js";
import { BOOLEAN_VARS, TRIGGER_TYPES, defaultCondition, defaultTrigger, varKey } from "../../lib/vision/catalog.js";
import { MiniCheck, MiniNumber, MiniSelect, MiniText, SignalPicker } from "./fields.js";

const WHO_TRIGGER = ["owner", "anyPerson", "anyDog", "anyone", "profile"] as const;
const SET_VARS = ["var.a", "var.b", "var.c"] as const;

function useOpts() {
    const { t } = useTranslation();
    return <T extends string>(values: readonly T[], prefix: string) => values.map((v) => ({ value: v, label: t(`${prefix}.${v}`) }));
}

/* ------------------------------------------------------------------ *
 * Trigger
 * ------------------------------------------------------------------ */

export function TriggerForm({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
    const { t } = useTranslation();
    const opts = useOpts();
    const identities = useAppStore((s) => s.identities);
    const typeSelect = (
        <MiniSelect
            label={t("vision.editor.triggerType")}
            value={trigger.type}
            options={opts(TRIGGER_TYPES, "vision.triggerTypes")}
            onChange={(v) => onChange(defaultTrigger(v as Trigger["type"]))}
        />
    );
    switch (trigger.type) {
        case "signal":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {typeSelect}
                    <div className="sm:col-span-2">
                        <SignalPicker label={t("vision.editor.signal")} value={trigger.signal} onChange={(signal) => onChange({ ...trigger, signal })} />
                    </div>
                    <MiniSelect
                        label={t("vision.editor.on")}
                        value={trigger.on}
                        options={opts(["start", "end", "hold"] as const, "vision.triggerOn")}
                        onChange={(on) => onChange({ ...trigger, on: on as typeof trigger.on })}
                    />
                    {trigger.on === "hold" && (
                        <MiniNumber
                            label={t("vision.editor.holdMs")}
                            value={trigger.holdMs}
                            min={0}
                            max={60_000}
                            step={50}
                            suffix="ms"
                            onCommit={(holdMs) => onChange({ ...trigger, holdMs })}
                        />
                    )}
                    <MiniNumber
                        label={t("vision.editor.minConfidence")}
                        value={Math.round(trigger.minConfidence * 100)}
                        min={0}
                        max={100}
                        suffix="%"
                        onCommit={(v) => onChange({ ...trigger, minConfidence: v / 100 })}
                    />
                    <MiniSelect
                        label={t("vision.editor.who")}
                        value={trigger.who}
                        options={opts(WHO_TRIGGER, "vision.who")}
                        onChange={(who) => {
                            const next = { ...trigger, who: who as typeof trigger.who };
                            if (who !== "profile") delete next.profileId;
                            else next.profileId = identities[0]?.id;
                            onChange(next);
                        }}
                    />
                    {trigger.who === "profile" && (
                        <MiniSelect
                            label={t("vision.editor.profile")}
                            value={trigger.profileId ?? ""}
                            options={[
                                { value: "", label: t("vision.editor.pickProfile") },
                                ...identities.map((p) => ({ value: p.id, label: p.name })),
                            ]}
                            onChange={(profileId) => {
                                const next = { ...trigger };
                                if (profileId) next.profileId = profileId;
                                else delete next.profileId;
                                onChange(next);
                            }}
                        />
                    )}
                </div>
            );
        case "chat":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {typeSelect}
                    <MiniText label={t("vision.editor.contains")} value={trigger.contains} maxLength={80} invalid={trigger.contains === ""} onChange={(contains) => onChange({ ...trigger, contains })} />
                </div>
            );
        case "gift":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {typeSelect}
                    <MiniNumber label={t("vision.editor.minDiamonds")} value={trigger.minDiamonds} min={0} max={1_000_000} onCommit={(minDiamonds) => onChange({ ...trigger, minDiamonds })} />
                </div>
            );
        case "control":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {typeSelect}
                    <MiniSelect
                        label={t("vision.editor.controlAction")}
                        value={trigger.action}
                        options={opts(CONTROL_ACTIONS, "vision.controlActions")}
                        onChange={(action) => onChange({ ...trigger, action: action as typeof trigger.action })}
                    />
                </div>
            );
        case "timer":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {typeSelect}
                    <MiniNumber
                        label={t("vision.editor.everyS")}
                        value={Math.round(trigger.everyMs / 1000)}
                        min={1}
                        max={3600}
                        suffix="s"
                        onCommit={(s) => onChange({ ...trigger, everyMs: s * 1000 })}
                    />
                </div>
            );
        case "follow":
        case "manual":
            return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{typeSelect}</div>;
    }
}

/* ------------------------------------------------------------------ *
 * Condition builder (nested all / any / not groups)
 * ------------------------------------------------------------------ */

const COND_TYPES = ["all", "any", "not", "compare", "signalActive"] as const;

export function ConditionBuilder({
    cond,
    onChange,
    onRemove,
    depth = 0,
}: {
    cond: Condition;
    onChange: (c: Condition) => void;
    onRemove?: () => void;
    depth?: number;
}) {
    const { t } = useTranslation();
    const opts = useOpts();
    const header = (
        <div className="flex items-end gap-2">
            <MiniSelect
                label={t("vision.editor.condType")}
                value={cond.type}
                options={opts(COND_TYPES, "vision.condTypes")}
                className="w-44"
                onChange={(v) => {
                    const type = v as Condition["type"];
                    // Keep children when switching between all/any.
                    if ((type === "all" || type === "any") && (cond.type === "all" || cond.type === "any")) onChange({ type, of: cond.of });
                    else if (type === "not") onChange({ type, of: cond });
                    else onChange(defaultCondition(type));
                }}
            />
            {onRemove && (
                <Button size="icon-sm" variant="ghost" aria-label={t("vision.editor.removeCondition")} title={t("vision.editor.removeCondition")} onClick={onRemove}>
                    <Trash2 />
                </Button>
            )}
        </div>
    );

    const frame = (body: React.ReactNode) => (
        <div
            className={cn(
                "flex flex-col gap-2 rounded-chip border border-border/70 p-2",
                depth % 2 === 0 ? "bg-panel" : "bg-panel-alt",
            )}
        >
            {header}
            {body}
        </div>
    );

    switch (cond.type) {
        case "all":
        case "any":
            return frame(
                <>
                    {cond.of.length === 0 && <p className="text-[0.6875rem] text-fg-subtle">{t("vision.editor.emptyGroup")}</p>}
                    <ul className="flex flex-col gap-2 border-l-2 border-accent/40 pl-2">
                        {cond.of.map((child, i) => (
                            <li key={i}>
                                <ConditionBuilder
                                    cond={child}
                                    depth={depth + 1}
                                    onChange={(c) => onChange({ ...cond, of: cond.of.map((x, j) => (j === i ? c : x)) })}
                                    onRemove={() => onChange({ ...cond, of: cond.of.filter((_, j) => j !== i) })}
                                />
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" variant="soft" icon={<Plus />} onClick={() => onChange({ ...cond, of: [...cond.of, defaultCondition("compare")] })}>
                            {t("vision.editor.addCompare")}
                        </Button>
                        <Button size="sm" variant="soft" icon={<Plus />} onClick={() => onChange({ ...cond, of: [...cond.of, defaultCondition("signalActive")] })}>
                            {t("vision.editor.addSignalCond")}
                        </Button>
                        {depth < 4 && (
                            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => onChange({ ...cond, of: [...cond.of, defaultCondition(cond.type === "all" ? "any" : "all")] })}>
                                {t("vision.editor.addGroup")}
                            </Button>
                        )}
                    </div>
                </>,
            );
        case "not":
            return frame(
                <div className="border-l-2 border-danger/40 pl-2">
                    <ConditionBuilder cond={cond.of} depth={depth + 1} onChange={(of) => onChange({ type: "not", of })} />
                </div>,
            );
        case "compare":
            return frame(<CompareFields cond={cond} onChange={onChange} />);
        case "signalActive":
            return frame(
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem]">
                    <SignalPicker label={t("vision.editor.signal")} value={cond.signal} onChange={(signal) => onChange({ ...cond, signal })} />
                    <MiniSelect
                        label={t("vision.editor.who")}
                        value={cond.who}
                        options={opts(["owner", "anyone"] as const, "vision.who")}
                        onChange={(who) => onChange({ ...cond, who: who as "owner" | "anyone" })}
                    />
                </div>,
            );
    }
}

function CompareFields({ cond, onChange }: { cond: Extract<Condition, { type: "compare" }>; onChange: (c: Condition) => void }) {
    const { t } = useTranslation();
    const isBool = BOOLEAN_VARS.has(cond.var);
    const ops = isBool ? (["eq", "ne"] as const) : COMPARE_OPS;
    return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem_8rem]">
            <MiniSelect
                label={t("vision.editor.variable")}
                value={cond.var}
                options={RULE_VARS.map((v) => ({ value: v, label: t(`vision.vars.${varKey(v)}`) }))}
                onChange={(v) => {
                    const variable = v as RuleVar;
                    const bool = BOOLEAN_VARS.has(variable);
                    onChange({
                        ...cond,
                        var: variable,
                        op: bool && cond.op !== "eq" && cond.op !== "ne" ? "eq" : cond.op,
                        value: bool ? (typeof cond.value === "boolean" ? cond.value : true) : typeof cond.value === "number" ? cond.value : 0,
                    });
                }}
            />
            <MiniSelect
                label={t("vision.editor.operator")}
                value={cond.op}
                options={ops.map((o) => ({ value: o, label: t(`vision.ops.${o}`) }))}
                onChange={(op) => onChange({ ...cond, op: op as typeof cond.op })}
            />
            {isBool ? (
                <MiniSelect
                    label={t("vision.editor.value")}
                    value={String(cond.value === true)}
                    options={[
                        { value: "true", label: t("vision.editor.true") },
                        { value: "false", label: t("vision.editor.false") },
                    ]}
                    onChange={(v) => onChange({ ...cond, value: v === "true" })}
                />
            ) : (
                <MiniNumber
                    label={t("vision.editor.value")}
                    value={typeof cond.value === "number" ? cond.value : 0}
                    min={-1_000_000_000}
                    max={1_000_000_000}
                    step={0.01}
                    onCommit={(value) => onChange({ ...cond, value })}
                />
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Action fields (own properties only; children are edited by the tree / graph)
 * ------------------------------------------------------------------ */

export function ActionFields({
    action,
    onChange,
    arObjectIds,
}: {
    action: RuleAction;
    onChange: (a: RuleAction) => void;
    arObjectIds: readonly string[];
}) {
    const { t } = useTranslation();
    const opts = useOpts();
    switch (action.type) {
        case "control":
            return <MiniSelect label={t("vision.actionTypes.control")} value={action.action} options={opts(CONTROL_ACTIONS, "vision.controlActions")} onChange={(v) => onChange({ ...action, action: v as typeof action.action })} />;
        case "camera":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <MiniSelect label={t("vision.actionTypes.camera")} value={action.action} options={opts(CAMERA_ACTIONS, "vision.cameraActions")} onChange={(v) => onChange({ ...action, action: v as typeof action.action })} />
                    <MiniNumber
                        label={t("vision.editor.holdMsOptional")}
                        value={action.holdMs ?? 0}
                        min={0}
                        max={5000}
                        step={50}
                        suffix="ms"
                        onCommit={(ms) => {
                            const next = { ...action };
                            if (ms >= 50) next.holdMs = ms;
                            else delete next.holdMs;
                            onChange(next);
                        }}
                    />
                </div>
            );
        case "studio":
            return <MiniSelect label={t("vision.actionTypes.studio")} value={action.action} options={opts(STUDIO_ACTIONS, "vision.studioActions")} onChange={(v) => onChange({ ...action, action: v as typeof action.action })} />;
        case "effect":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <MiniSelect label={t("vision.actionTypes.effect")} value={action.effect} options={opts(AR_EFFECTS, "vision.effects")} onChange={(v) => onChange({ ...action, effect: v as typeof action.effect })} />
                    <MiniNumber
                        label={t("vision.editor.depthM")}
                        value={action.z ?? 0}
                        min={0}
                        max={6}
                        step={0.1}
                        suffix="m"
                        onCommit={(z) => {
                            const next = { ...action };
                            if (z >= 0.3) next.z = z;
                            else delete next.z;
                            onChange(next);
                        }}
                    />
                </div>
            );
        case "arObject":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {arObjectIds.length > 0 ? (
                        <MiniSelect
                            label={t("vision.editor.arObject")}
                            value={action.objectId}
                            options={[...new Set([action.objectId, ...arObjectIds])].map((id) => ({ value: id, label: id }))}
                            onChange={(objectId) => onChange({ ...action, objectId })}
                        />
                    ) : (
                        <MiniText label={t("vision.editor.arObject")} value={action.objectId} maxLength={64} invalid={action.objectId === ""} onChange={(objectId) => onChange({ ...action, objectId })} />
                    )}
                    <MiniSelect label={t("vision.editor.arOp")} value={action.op} options={opts(["show", "hide", "toggle"] as const, "vision.arOps")} onChange={(v) => onChange({ ...action, op: v as typeof action.op })} />
                </div>
            );
        case "pet":
            return <MiniSelect label={t("vision.actionTypes.pet")} value={action.reaction} options={opts(PET_REACTIONS, "vision.petReactions")} onChange={(v) => onChange({ ...action, reaction: v as typeof action.reaction })} />;
        case "speak":
            return <MiniText label={t("vision.editor.text")} value={action.text} maxLength={300} invalid={action.text === ""} onChange={(text) => onChange({ ...action, text })} />;
        case "notify":
            return <MiniText label={t("vision.editor.text")} value={action.text} maxLength={200} invalid={action.text === ""} onChange={(text) => onChange({ ...action, text })} />;
        case "vmuiFlash":
            return <MiniText label={t("vision.editor.color")} value={action.color} maxLength={32} invalid={action.color === ""} onChange={(color) => onChange({ ...action, color })} />;
        case "vmuiScene":
            return <MiniText label={t("vision.editor.scene")} value={action.scene} maxLength={64} invalid={action.scene === ""} onChange={(scene) => onChange({ ...action, scene })} />;
        case "highlight":
            return (
                <MiniText
                    label={t("vision.editor.labelOptional")}
                    value={action.label ?? ""}
                    maxLength={60}
                    onChange={(label) => {
                        const next = { ...action };
                        if (label) next.label = label;
                        else delete next.label;
                        onChange(next);
                    }}
                />
            );
        case "set":
            return (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <MiniSelect label={t("vision.editor.variable")} value={action.var} options={SET_VARS.map((v) => ({ value: v, label: t(`vision.vars.${varKey(v)}`) }))} onChange={(v) => onChange({ ...action, var: v as typeof action.var })} />
                    <MiniSelect label={t("vision.editor.operator")} value={action.op} options={opts(["set", "inc", "dec"] as const, "vision.setOps")} onChange={(v) => onChange({ ...action, op: v as typeof action.op })} />
                    <MiniNumber label={t("vision.editor.value")} value={action.value} min={-1_000_000} max={1_000_000} step={0.01} onCommit={(value) => onChange({ ...action, value })} />
                </div>
            );
        case "if":
            return <ConditionBuilder cond={action.cond} onChange={(cond) => onChange({ ...action, cond })} />;
        case "wait":
            return <MiniNumber label={t("vision.editor.waitMs")} value={action.ms} min={0} max={600_000} step={50} suffix="ms" onCommit={(ms) => onChange({ ...action, ms })} />;
        case "repeat":
            return <MiniNumber label={t("vision.editor.count")} value={action.count} min={1} max={50} onCommit={(count) => onChange({ ...action, count })} />;
        case "parallel":
            return (
                <MiniNumber
                    label={t("vision.editor.branchCount")}
                    value={action.branches.length}
                    min={1}
                    max={8}
                    onCommit={(n) => onChange({ ...action, branches: Array.from({ length: n }, (_, k) => action.branches[k] ?? []) })}
                />
            );
        case "stop":
            return <p className="text-[0.6875rem] text-fg-muted">{t("vision.editor.stopHint")}</p>;
    }
}

/** Rule-level settings shared by both editor views. */
export function RuleMetaFields({
    name,
    enabled,
    requiresArm,
    mode,
    cooldownMs,
    onChange,
}: {
    name: string;
    enabled: boolean;
    requiresArm: boolean;
    mode: "single" | "restart" | "queued" | "parallel";
    cooldownMs: number;
    onChange: (patch: Partial<{ name: string; enabled: boolean; requiresArm: boolean; mode: typeof mode; cooldownMs: number }>) => void;
}) {
    const { t } = useTranslation();
    const opts = useOpts();
    return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MiniText label={t("vision.editor.name")} value={name} maxLength={80} invalid={name.trim() === ""} onChange={(v) => onChange({ name: v })} className="lg:col-span-2" />
            <MiniSelect label={t("vision.editor.mode")} value={mode} options={opts(["single", "restart", "queued", "parallel"] as const, "vision.modes")} onChange={(v) => onChange({ mode: v as typeof mode })} />
            <MiniNumber label={t("vision.editor.cooldownS")} value={cooldownMs / 1000} min={0} max={3600} step={0.1} suffix="s" onCommit={(s) => onChange({ cooldownMs: Math.round(s * 1000) })} />
            <MiniCheck label={t("vision.editor.enabled")} checked={enabled} onChange={(v) => onChange({ enabled: v })} />
            <MiniCheck label={t("vision.editor.requiresArm")} checked={requiresArm} onChange={(v) => onChange({ requiresArm: v })} className="sm:col-span-3" />
        </div>
    );
}
