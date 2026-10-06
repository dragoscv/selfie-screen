import { defaultRules, ruleSchema, type Rule, type RuleFired } from "@tiksee/core";
import { Button, Card, EmptyState, StatusPill, SwitchRow, cn } from "@tiksee/ui";
import { ArrowDown, ArrowUp, Copy, FlaskConical, ListTree, Pencil, Plus, RotateCcw, Share2, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { Suspense, lazy, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { blankRule, duplicateRule, issueKey, moveItem, uniqueRuleId } from "../../lib/vision/catalog.js";
import { formatMs } from "../../lib/vision/log.js";
import { useVisionLabels, useVisionSettings } from "../../lib/vision/use-vision.js";
import { useAppStore } from "../../store/app-store.js";
import { ConfirmDialog } from "./fields.js";
import { RuleMetaFields } from "./rule-forms.js";
import { RuleListEditor } from "./rule-list-editor.js";

// xyflow + dagre stay in their own chunk, loaded only when the graph view opens.
const RuleGraphEditor = lazy(() => import("./rule-graph-editor.js"));

export function RulesTab() {
    const { t, i18n } = useTranslation();
    const labels = useVisionLabels();
    const [vision, patch] = useVisionSettings();
    const fired = useAppStore((s) => s.ruleFired);
    const [editing, setEditing] = useState<{ rule: Rule; isNew: boolean } | null>(null);
    const [confirm, setConfirm] = useState<null | { kind: "reset" } | { kind: "delete"; id: string; name: string }>(null);

    const lastFired = useMemo(() => {
        const map = new Map<string, RuleFired>();
        for (const f of fired) if (!map.has(f.ruleId)) map.set(f.ruleId, f);
        return map;
    }, [fired]);

    const rules = vision.rules;
    const setRules = (next: Rule[]) => patch({ rules: next });

    if (editing) {
        return (
            <RuleEditor
                initial={editing.rule}
                isNew={editing.isNew}
                takenIds={rules.map((r) => r.id).filter((id) => id !== editing.rule.id)}
                onCancel={() => setEditing(null)}
                onSave={(rule) => {
                    const exists = rules.some((r) => r.id === editing.rule.id);
                    setRules(exists ? rules.map((r) => (r.id === editing.rule.id ? rule : r)) : [...rules, rule]);
                    setEditing(null);
                    toast.success(t("vision.rules.saved"));
                }}
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <Card
                title={t("vision.rules.title")}
                subtitle={t("vision.rules.hint")}
                icon={<Workflow />}
                actions={
                    <>
                        <Button
                            size="sm"
                            variant="primary"
                            icon={<Plus />}
                            disabled={rules.length >= 200}
                            onClick={() => {
                                const name = t("vision.rules.newName");
                                setEditing({ rule: blankRule(uniqueRuleId(name, rules.map((r) => r.id)), name), isNew: true });
                            }}
                        >
                            {t("vision.rules.add")}
                        </Button>
                        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => setConfirm({ kind: "reset" })}>
                            {t("vision.rules.reset")}
                        </Button>
                    </>
                }
            >
                <SwitchRow
                    label={t("vision.rules.rulesEnabled")}
                    description={t("vision.rules.rulesEnabledHint")}
                    checked={vision.rulesEnabled}
                    onChange={(rulesEnabled) => patch({ rulesEnabled })}
                />
            </Card>

            {rules.length === 0 ? (
                <EmptyState icon={<Workflow />} title={t("vision.rules.empty")} description={t("vision.rules.emptyHint")} />
            ) : (
                <ol className="flex flex-col gap-2" aria-label={t("vision.rules.title")}>
                    {rules.map((rule, i) => {
                        const last = lastFired.get(rule.id);
                        return (
                            <li key={rule.id} className={cn("surface flex flex-col gap-2 rounded-card p-3", !rule.enabled && "opacity-70")}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="no-drag inline-flex min-h-9 items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={rule.enabled}
                                            onChange={(e) => setRules(rules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))}
                                            className="size-4 accent-[var(--accent)]"
                                        />
                                        <span className="sr-only">{t("vision.rules.enable", { name: rule.name })}</span>
                                    </label>
                                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{rule.name}</p>
                                    {rule.requiresArm && (
                                        <StatusPill tone="warning">
                                            <ShieldCheck className="size-3" aria-hidden />
                                            {t("vision.rules.requiresArm")}
                                        </StatusPill>
                                    )}
                                    <span className="text-[0.6875rem] tabular-nums text-fg-muted">
                                        {t("vision.rules.cooldown", { time: formatMs(rule.cooldownMs) })}
                                    </span>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {rule.triggers.map((tr, k) => (
                                        <span key={k} className="rounded-full bg-accent-subtle px-2 py-0.5 text-[0.6875rem] text-accent">
                                            {labels.trigger(tr)}
                                        </span>
                                    ))}
                                    {rule.when && (
                                        <span className="rounded-full bg-panel-alt px-2 py-0.5 text-[0.6875rem] text-fg-muted">
                                            {t("vision.rules.whenChip", { cond: labels.condition(rule.when) })}
                                        </span>
                                    )}
                                </div>
                                <p className="truncate text-[0.6875rem] text-fg-muted">
                                    → {rule.actions.map(labels.action).join(" · ") || t("vision.editor.noActions")}
                                </p>
                                <div className="flex flex-wrap items-center gap-1">
                                    <span className="mr-auto text-[0.6875rem] text-fg-subtle" aria-live="polite">
                                        {last
                                            ? last.blocked
                                                ? t("vision.rules.lastBlocked", { time: new Date(last.at).toLocaleTimeString(i18n.language), reason: last.blocked })
                                                : t("vision.rules.lastFired", { time: new Date(last.at).toLocaleTimeString(i18n.language) })
                                            : t("vision.rules.neverFired")}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="soft"
                                        icon={<FlaskConical />}
                                        onClick={() => {
                                            sidecarClient.send({ type: "ruleTest", ruleId: rule.id });
                                            toast(t("vision.rules.testSent", { name: rule.name }));
                                        }}
                                    >
                                        {t("vision.rules.test")}
                                    </Button>
                                    <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing({ rule: structuredClone(rule), isNew: false })}>
                                        {t("vision.rules.edit")}
                                    </Button>
                                    <Button size="icon-sm" variant="ghost" disabled={i === 0} aria-label={t("vision.editor.moveUp", { name: rule.name })} title={t("vision.editor.moveUp", { name: rule.name })} onClick={() => setRules(moveItem(rules, i, i - 1))}>
                                        <ArrowUp />
                                    </Button>
                                    <Button size="icon-sm" variant="ghost" disabled={i === rules.length - 1} aria-label={t("vision.editor.moveDown", { name: rule.name })} title={t("vision.editor.moveDown", { name: rule.name })} onClick={() => setRules(moveItem(rules, i, i + 1))}>
                                        <ArrowDown />
                                    </Button>
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        disabled={rules.length >= 200}
                                        aria-label={t("vision.rules.duplicate", { name: rule.name })}
                                        title={t("vision.rules.duplicate", { name: rule.name })}
                                        onClick={() => {
                                            const copy = duplicateRule(rule, t("vision.rules.copyName", { name: rule.name }), rules.map((r) => r.id));
                                            setRules([...rules.slice(0, i + 1), copy, ...rules.slice(i + 1)]);
                                        }}
                                    >
                                        <Copy />
                                    </Button>
                                    <Button size="icon-sm" variant="ghost" aria-label={t("vision.rules.delete", { name: rule.name })} title={t("vision.rules.delete", { name: rule.name })} onClick={() => setConfirm({ kind: "delete", id: rule.id, name: rule.name })}>
                                        <Trash2 />
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}

            <ConfirmDialog
                open={confirm !== null}
                title={confirm?.kind === "delete" ? t("vision.rules.deleteTitle", { name: confirm.name }) : t("vision.rules.resetTitle")}
                body={confirm?.kind === "delete" ? t("vision.rules.deleteBody") : t("vision.rules.resetBody")}
                confirmLabel={confirm?.kind === "delete" ? t("common.delete") : t("vision.rules.reset")}
                danger
                onClose={() => setConfirm(null)}
                onConfirm={() => {
                    if (confirm?.kind === "delete") setRules(rules.filter((r) => r.id !== confirm.id));
                    else if (confirm?.kind === "reset") setRules(defaultRules());
                }}
            />
        </div>
    );
}

type View = "list" | "graph";

function RuleEditor({
    initial,
    isNew,
    takenIds,
    onCancel,
    onSave,
}: {
    initial: Rule;
    isNew: boolean;
    takenIds: readonly string[];
    onCancel: () => void;
    onSave: (rule: Rule) => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<Rule>(initial);
    const [view, setView] = useState<View>("list");
    const [showErrors, setShowErrors] = useState(false);
    const arObjectIds = useAppStore((s) => s.settings.studio.arObjects).map((o) => o.id);

    const parsed = useMemo(() => ruleSchema.safeParse(draft), [draft]);
    const errors = useMemo(() => {
        const map = new Map<string, string>();
        if (!parsed.success) for (const issue of parsed.error.issues) map.set(issueKey(issue.path), issue.message);
        if (takenIds.includes(draft.id)) map.set("id", t("vision.editor.idTaken"));
        return map;
    }, [parsed, takenIds, draft.id, t]);
    const shown = showErrors ? errors : new Map<string, string>();

    const save = () => {
        if (!parsed.success || errors.size > 0) {
            setShowErrors(true);
            toast.error(t("vision.editor.invalid", { count: errors.size }));
            return;
        }
        onSave(parsed.data);
    };

    return (
        <div className="flex flex-col gap-3">
            <Card
                title={isNew ? t("vision.editor.newTitle") : t("vision.editor.editTitle", { name: initial.name })}
                icon={<Pencil />}
                actions={
                    <>
                        <div role="radiogroup" aria-label={t("vision.editor.view")} className="flex rounded-chip bg-panel-alt p-0.5">
                            {(["list", "graph"] as const).map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    role="radio"
                                    aria-checked={view === v}
                                    onClick={() => setView(v)}
                                    className={cn(
                                        "no-drag inline-flex min-h-8 items-center gap-1.5 rounded-chip px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        view === v ? "bg-panel font-semibold text-accent shadow-sm" : "text-fg-muted hover:text-fg",
                                    )}
                                >
                                    {v === "list" ? <ListTree className="size-3.5" aria-hidden /> : <Share2 className="size-3.5" aria-hidden />}
                                    {t(`vision.editor.views.${v}`)}
                                </button>
                            ))}
                        </div>
                        <Button size="sm" variant="ghost" onClick={onCancel}>
                            {t("common.cancel")}
                        </Button>
                        <Button size="sm" onClick={save}>
                            {t("common.save")}
                        </Button>
                    </>
                }
            >
                <RuleMetaFields
                    name={draft.name}
                    enabled={draft.enabled}
                    requiresArm={draft.requiresArm}
                    mode={draft.mode}
                    cooldownMs={draft.cooldownMs}
                    onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
                />
                {showErrors && errors.size > 0 && (
                    <p role="alert" className="rounded-chip bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger">
                        {t("vision.editor.invalid", { count: errors.size })}
                    </p>
                )}
            </Card>

            <div className="surface rounded-card p-3">
                {view === "list" ? (
                    <RuleListEditor rule={draft} onChange={setDraft} errors={shown} arObjectIds={arObjectIds} />
                ) : (
                    <Suspense fallback={<p className="p-6 text-center text-xs text-fg-muted">{t("common.loading")}</p>}>
                        <RuleGraphEditor key={draft.id} rule={draft} onChange={setDraft} arObjectIds={arObjectIds} />
                    </Suspense>
                )}
                {view === "graph" && shown.size > 0 && (
                    <ul role="alert" className="mt-2 text-[0.6875rem] text-danger">
                        {[...shown].map(([k, m]) => (
                            <li key={k}>
                                {k}: {m}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
