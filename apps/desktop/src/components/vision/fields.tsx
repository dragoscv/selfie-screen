import { SIGNAL_FAMILIES, type SignalId } from "@tiksee/core";
import { Button, cn } from "@tiksee/ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SIGNAL_EMOJI, signalsByFamily } from "../../lib/vision/catalog.js";

const MINI_FIELD = cn(
    "no-drag h-9 w-full rounded-chip border border-border bg-panel-alt px-2 text-xs text-fg",
    "outline-none transition-[border-color,box-shadow] duration-(--dur-fast)",
    "focus:border-accent focus:ring-2 focus:ring-ring/40",
    "aria-[invalid=true]:border-danger",
);

export interface MiniOption {
    value: string;
    label: string;
}

/** Compact labelled native select. */
export function MiniSelect({
    label,
    value,
    options,
    onChange,
    className,
    groups,
}: {
    label: string;
    value: string;
    options?: readonly MiniOption[];
    groups?: ReadonlyArray<{ label: string; options: readonly MiniOption[] }>;
    onChange: (value: string) => void;
    className?: string;
}) {
    const id = useId();
    return (
        <div className={cn("min-w-0 space-y-1", className)}>
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={MINI_FIELD}>
                {options?.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
                {groups?.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                        {g.options.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>
        </div>
    );
}

/** Number input that commits on blur/Enter, clamped; accepts decimals when `step` < 1. */
export function MiniNumber({
    label,
    value,
    min,
    max,
    step = 1,
    suffix,
    onCommit,
    className,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
    onCommit: (value: number) => void;
    className?: string;
}) {
    const id = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const parsed = Number.parseFloat(draft.replace(",", "."));
        setDraft(null);
        if (!Number.isFinite(parsed)) return;
        const rounded = step >= 1 ? Math.round(parsed) : parsed;
        onCommit(Math.min(max, Math.max(min, rounded)));
    };
    return (
        <div className={cn("min-w-0 space-y-1", className)}>
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <div className="flex items-center gap-1">
                <input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    min={min}
                    max={max}
                    step={step}
                    value={draft ?? String(value)}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                    }}
                    className={cn(MINI_FIELD, "tabular-nums")}
                />
                {suffix !== undefined && <span className="shrink-0 text-[0.6875rem] text-fg-subtle">{suffix}</span>}
            </div>
        </div>
    );
}

export function MiniText({
    label,
    value,
    onChange,
    maxLength,
    className,
    invalid,
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    maxLength?: number;
    className?: string;
    invalid?: boolean;
    placeholder?: string;
}) {
    const id = useId();
    return (
        <div className={cn("min-w-0 space-y-1", className)}>
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <input
                id={id}
                type="text"
                value={value}
                maxLength={maxLength}
                placeholder={placeholder}
                aria-invalid={invalid || undefined}
                onChange={(e) => onChange(e.target.value)}
                className={MINI_FIELD}
            />
        </div>
    );
}

export function MiniCheck({
    label,
    checked,
    onChange,
    className,
}: {
    label: ReactNode;
    checked: boolean;
    onChange: (checked: boolean) => void;
    className?: string;
}) {
    return (
        <label className={cn("no-drag inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-fg", className)}>
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="size-4 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {label}
        </label>
    );
}

/** Signal picker: a search box filtering a select grouped by family. */
export function SignalPicker({
    label,
    value,
    onChange,
}: {
    label: string;
    value: SignalId;
    onChange: (value: SignalId) => void;
}) {
    const { t } = useTranslation();
    const id = useId();
    const [query, setQuery] = useState("");
    const groups = useMemo(() => {
        const by = signalsByFamily();
        const q = query.trim().toLowerCase();
        return SIGNAL_FAMILIES.map((family) => ({
            family,
            ids: by[family].filter(
                (s) => s === value || q === "" || s.includes(q) || t(`vision.signals.${s}`).toLowerCase().includes(q),
            ),
        })).filter((g) => g.ids.length > 0);
    }, [query, t, value]);
    return (
        <div className="min-w-0 space-y-1">
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <div className="flex gap-1">
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("vision.editor.search")}
                    aria-label={`${label} — ${t("vision.editor.search")}`}
                    className={cn(MINI_FIELD, "w-28 shrink-0")}
                />
                <select id={id} value={value} onChange={(e) => onChange(e.target.value as SignalId)} className={MINI_FIELD}>
                    {groups.map((g) => (
                        <optgroup key={g.family} label={t(`vision.families.${g.family}`)}>
                            {g.ids.map((s) => (
                                <option key={s} value={s}>
                                    {SIGNAL_EMOJI[s]} {t(`vision.signals.${s}`)}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            </div>
        </div>
    );
}

/** Modal confirm built on the native <dialog> (focus trap + Escape for free). */
export function ConfirmDialog({
    open,
    title,
    body,
    confirmLabel,
    danger = false,
    onConfirm,
    onClose,
}: {
    open: boolean;
    title: string;
    body: ReactNode;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        else if (!open && d.open) d.close();
    }, [open]);
    return (
        <dialog
            ref={ref}
            aria-labelledby={titleId}
            onClose={onClose}
            className="surface m-auto w-[min(28rem,92vw)] rounded-card p-5 text-fg backdrop:bg-black/50"
        >
            <h2 id={titleId} className="text-sm font-semibold">
                {title}
            </h2>
            <div className="mt-2 text-xs leading-relaxed text-fg-muted">{body}</div>
            <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} autoFocus>
                    {t("common.cancel")}
                </Button>
                <Button
                    variant={danger ? "danger" : "primary"}
                    size="sm"
                    onClick={() => {
                        onConfirm();
                        onClose();
                    }}
                >
                    {confirmLabel}
                </Button>
            </div>
        </dialog>
    );
}

/** WAI-ARIA tabs with roving focus (arrow keys, Home/End). */
export function Tabs<T extends string>({
    label,
    tabs,
    value,
    onChange,
    display,
    idPrefix,
}: {
    label: string;
    tabs: readonly T[];
    value: T;
    onChange: (value: T) => void;
    display: (value: T) => ReactNode;
    idPrefix: string;
}) {
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const onKey = (e: KeyboardEvent, i: number) => {
        let next = -1;
        if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        const tab = tabs[next];
        if (tab !== undefined) onChange(tab);
        refs.current[next]?.focus();
    };
    return (
        <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-border/60 px-4">
            {tabs.map((tab, i) => {
                const selected = tab === value;
                return (
                    <button
                        key={tab}
                        ref={(el) => {
                            refs.current[i] = el;
                        }}
                        type="button"
                        role="tab"
                        id={`${idPrefix}-tab-${tab}`}
                        aria-selected={selected}
                        aria-controls={`${idPrefix}-panel-${tab}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onChange(tab)}
                        onKeyDown={(e) => onKey(e, i)}
                        className={cn(
                            "no-drag -mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-xs outline-none",
                            "transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                            selected ? "border-accent font-semibold text-accent" : "border-transparent text-fg-muted hover:text-fg",
                        )}
                    >
                        {display(tab)}
                    </button>
                );
            })}
        </div>
    );
}
