import type { Rule, RuleAction } from "@tiksee/core";
import { Button, cn } from "@tiksee/ui";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ACTION_CATEGORIES, ACTION_EMOJI, defaultAction, defaultCondition, defaultTrigger, moveItem, type ActionType } from "../../lib/vision/catalog.js";
import { useVisionLabels } from "../../lib/vision/use-vision.js";
import { ActionFields, ConditionBuilder, TriggerForm } from "./rule-forms.js";

/** List-form editor of one rule. Triggers (OR) → optional guard → nested action tree. */
export function RuleListEditor({
    rule,
    onChange,
    errors,
    arObjectIds,
}: {
    rule: Rule;
    onChange: (rule: Rule) => void;
    errors: ReadonlyMap<string, string>;
    arObjectIds: readonly string[];
}) {
    const { t } = useTranslation();
    const labels = useVisionLabels();

    return (
        <div className="flex flex-col gap-4">
            <section aria-labelledby="rule-triggers" className="flex flex-col gap-2">
                <h3 id="rule-triggers" className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {t("vision.editor.triggers")} <span className="font-normal normal-case">— {t("vision.editor.triggersHint")}</span>
                </h3>
                <ol className="flex flex-col gap-2">
                    {rule.triggers.map((trigger, i) => (
                        <li key={i} className="rounded-chip border border-border/70 bg-panel p-2">
                            <div className="mb-2 flex items-center gap-2">
                                {i > 0 && <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[0.625rem] font-bold text-accent">{t("vision.editor.or")}</span>}
                                <span className="min-w-0 flex-1 truncate text-xs text-fg">{labels.trigger(trigger)}</span>
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    disabled={rule.triggers.length <= 1}
                                    aria-label={t("vision.editor.removeTrigger")}
                                    title={t("vision.editor.removeTrigger")}
                                    onClick={() => onChange({ ...rule, triggers: rule.triggers.filter((_, j) => j !== i) })}
                                >
                                    <Trash2 />
                                </Button>
                            </div>
                            <TriggerForm trigger={trigger} onChange={(next) => onChange({ ...rule, triggers: rule.triggers.map((x, j) => (j === i ? next : x)) })} />
                            <FieldError errors={errors} prefix={`triggers.${i}`} />
                        </li>
                    ))}
                </ol>
                <div>
                    <Button
                        size="sm"
                        variant="soft"
                        icon={<Plus />}
                        disabled={rule.triggers.length >= 8}
                        onClick={() => onChange({ ...rule, triggers: [...rule.triggers, defaultTrigger("signal")] })}
                    >
                        {t("vision.editor.addTrigger")}
                    </Button>
                </div>
            </section>

            <section aria-labelledby="rule-when" className="flex flex-col gap-2">
                <h3 id="rule-when" className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {t("vision.editor.when")}
                </h3>
                {rule.when ? (
                    <ConditionBuilder
                        cond={rule.when}
                        onChange={(when) => onChange({ ...rule, when })}
                        onRemove={() => {
                            const next = { ...rule };
                            delete next.when;
                            onChange(next);
                        }}
                    />
                ) : (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-fg-subtle">{t("vision.editor.gateAlways")}</span>
                        <Button size="sm" variant="soft" icon={<Plus />} onClick={() => onChange({ ...rule, when: { type: "all", of: [defaultCondition("compare")] } })}>
                            {t("vision.editor.addWhen")}
                        </Button>
                    </div>
                )}
                <FieldError errors={errors} prefix="when" />
            </section>

            <section aria-labelledby="rule-actions" className="flex flex-col gap-2">
                <h3 id="rule-actions" className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {t("vision.editor.actions")}
                </h3>
                <ActionList
                    list={rule.actions}
                    path="actions"
                    onChange={(actions) => onChange({ ...rule, actions })}
                    errors={errors}
                    arObjectIds={arObjectIds}
                    depth={0}
                />
            </section>
        </div>
    );
}

function FieldError({ errors, prefix }: { errors: ReadonlyMap<string, string>; prefix: string }) {
    const messages = [...errors].filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));
    if (messages.length === 0) return null;
    return (
        <ul className="mt-1 text-[0.6875rem] text-danger" role="alert">
            {messages.map(([k, m]) => (
                <li key={k}>
                    {k}: {m}
                </li>
            ))}
        </ul>
    );
}

function ActionList({
    list,
    path,
    onChange,
    errors,
    arObjectIds,
    depth,
}: {
    list: readonly RuleAction[];
    path: string;
    onChange: (list: RuleAction[]) => void;
    errors: ReadonlyMap<string, string>;
    arObjectIds: readonly string[];
    depth: number;
}) {
    const { t } = useTranslation();
    return (
        <div className={cn("flex flex-col gap-2", depth > 0 && "border-l-2 border-border pl-2")}>
            {list.length === 0 && <p className="text-[0.6875rem] text-fg-subtle">{t("vision.editor.noActions")}</p>}
            <ol className="flex flex-col gap-2">
                {list.map((action, i) => (
                    <li key={i}>
                        <ActionItem
                            action={action}
                            index={i}
                            count={list.length}
                            path={`${path}.${i}`}
                            errors={errors}
                            arObjectIds={arObjectIds}
                            depth={depth}
                            onChange={(a) => onChange(list.map((x, j) => (j === i ? a : x)))}
                            onMove={(to) => onChange(moveItem(list, i, to))}
                            onRemove={() => onChange(list.filter((_, j) => j !== i))}
                            onDuplicate={() => onChange([...list.slice(0, i + 1), structuredClone(action), ...list.slice(i + 1)])}
                        />
                    </li>
                ))}
            </ol>
            <AddActionMenu disabled={list.length >= 64} onAdd={(type) => onChange([...list, defaultAction(type)])} />
        </div>
    );
}

function ActionItem({
    action,
    index,
    count,
    path,
    errors,
    arObjectIds,
    depth,
    onChange,
    onMove,
    onRemove,
    onDuplicate,
}: {
    action: RuleAction;
    index: number;
    count: number;
    path: string;
    errors: ReadonlyMap<string, string>;
    arObjectIds: readonly string[];
    depth: number;
    onChange: (a: RuleAction) => void;
    onMove: (to: number) => void;
    onRemove: () => void;
    onDuplicate: () => void;
}) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    const name = labels.actionType(action.type);
    const child = (list: RuleAction[], sub: string, set: (l: RuleAction[]) => void) => (
        <ActionList list={list} path={`${path}.${sub}`} onChange={set} errors={errors} arObjectIds={arObjectIds} depth={depth + 1} />
    );
    return (
        <div className={cn("rounded-chip border border-border/70 p-2", depth % 2 === 0 ? "bg-panel" : "bg-panel-alt")}>
            <div className="mb-2 flex items-center gap-1">
                <span aria-hidden className="text-sm">
                    {ACTION_EMOJI[action.type]}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
                    {index + 1}. {name}
                </span>
                <Button size="icon-sm" variant="ghost" disabled={index === 0} aria-label={t("vision.editor.moveUp", { name })} title={t("vision.editor.moveUp", { name })} onClick={() => onMove(index - 1)}>
                    <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" disabled={index >= count - 1} aria-label={t("vision.editor.moveDown", { name })} title={t("vision.editor.moveDown", { name })} onClick={() => onMove(index + 1)}>
                    <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("vision.editor.duplicateAction", { name })} title={t("vision.editor.duplicateAction", { name })} onClick={onDuplicate}>
                    <Copy />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t("vision.editor.removeAction", { name })} title={t("vision.editor.removeAction", { name })} onClick={onRemove}>
                    <Trash2 />
                </Button>
            </div>
            <ActionFields action={action} onChange={onChange} arObjectIds={arObjectIds} />
            <FieldError errors={errors} prefix={path} />
            {action.type === "if" && (
                <div className="mt-2 grid grid-cols-1 gap-2 xl:grid-cols-2">
                    <div>
                        <p className="mb-1 text-[0.6875rem] font-bold uppercase text-success">{t("vision.editor.then")}</p>
                        {child(action.then, "then", (then) => onChange({ ...action, then }))}
                    </div>
                    <div>
                        <p className="mb-1 text-[0.6875rem] font-bold uppercase text-danger">{t("vision.editor.else")}</p>
                        {child(action.else, "else", (els) => onChange({ ...action, else: els }))}
                    </div>
                </div>
            )}
            {action.type === "repeat" && <div className="mt-2">{child(action.do, "do", (d) => onChange({ ...action, do: d }))}</div>}
            {action.type === "parallel" && (
                <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {action.branches.map((branch, k) => (
                        <div key={k}>
                            <p className="mb-1 text-[0.6875rem] font-bold uppercase text-fg-muted">{t("vision.editor.branch", { n: k + 1 })}</p>
                            {child(branch, `branches.${k}`, (l) => onChange({ ...action, branches: action.branches.map((b, j) => (j === k ? l : b)) }))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Disclosure menu of action types by category; Escape closes and returns focus. */
export function AddActionMenu({ onAdd, disabled }: { onAdd: (type: ActionType) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const menuId = useId();
    const wrapRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }, [open]);
    const close = () => {
        setOpen(false);
        wrapRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    return (
        <div className="relative" ref={wrapRef}>
            <Button
                size="sm"
                variant="soft"
                icon={<Plus />}
                disabled={disabled}
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => setOpen((o) => !o)}
            >
                {t("vision.editor.addAction")}
            </Button>
            {open && (
                <div
                    id={menuId}
                    ref={panelRef}
                    role="group"
                    aria-label={t("vision.editor.addAction")}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.stopPropagation();
                            close();
                        }
                    }}
                    className="surface absolute left-0 z-30 mt-1 grid w-[min(34rem,90vw)] grid-cols-1 gap-2 rounded-card p-2 shadow-lg sm:grid-cols-3"
                >
                    {ACTION_CATEGORIES.map((cat) => (
                        <div key={cat.id}>
                            <p className="px-1 pb-1 text-[0.625rem] font-bold uppercase tracking-wide text-fg-muted">{t(`vision.actionCategories.${cat.id}`)}</p>
                            {cat.types.map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    onClick={() => {
                                        onAdd(type);
                                        close();
                                    }}
                                    className="no-drag flex min-h-9 w-full items-center gap-2 rounded-chip px-2 text-left text-xs text-fg outline-none hover:bg-panel-alt focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span aria-hidden>{ACTION_EMOJI[type]}</span>
                                    {t(`vision.actionTypes.${type}`)}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
