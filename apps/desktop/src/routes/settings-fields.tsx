import { cn } from "@tiksee/ui";
import { useId, useState, type ReactNode } from "react";

const FIELD = cn(
    "no-drag w-full rounded-control border border-border bg-panel-alt px-3 py-2 text-sm text-fg",
    "outline-none transition-[border-color,box-shadow] duration-(--dur-fast)",
    "focus:border-accent focus:ring-2 focus:ring-ring/40",
);

export interface SelectOption {
    value: string;
    label: string;
}

/** Labelled native select — keyboard and screen-reader behaviour for free. */
export function SelectField({
    label,
    value,
    options,
    onChange,
    hint,
}: {
    label: ReactNode;
    value: string;
    options: readonly SelectOption[];
    onChange: (value: string) => void;
    hint?: ReactNode;
}) {
    const id = useId();
    return (
        <div className="space-y-1.5">
            <label htmlFor={id} className="block text-[0.8125rem] text-fg-muted">
                {label}
            </label>
            <select
                id={id}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
                className={FIELD}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            {hint !== undefined && (
                <p id={`${id}-hint`} className="text-[0.6875rem] text-fg-muted">
                    {hint}
                </p>
            )}
        </div>
    );
}

/**
 * Integer input that commits on blur/Enter and clamps to range. Typing a
 * partial number ("1" on the way to "120") must not be clamped mid-edit.
 */
export function NumberField({
    label,
    value,
    min,
    max,
    onCommit,
    suffix,
    className,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onCommit: (value: number) => void;
    suffix?: string;
    className?: string;
}) {
    const id = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        const parsed = Number.parseInt(draft, 10);
        setDraft(null);
        if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
    };
    return (
        <div className={cn("space-y-1", className)}>
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <div className="flex items-center gap-1.5">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    value={draft ?? String(value)}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commit();
                    }}
                    className={cn(FIELD, "tabular-nums")}
                />
                {suffix !== undefined && <span className="shrink-0 text-xs text-fg-subtle">{suffix}</span>}
            </div>
        </div>
    );
}

/** Multi-select rendered as toggle chips (aria-pressed). */
export function ChipToggleGroup<T extends string>({
    label,
    options,
    selected,
    onChange,
    display,
    swatch,
}: {
    label: string;
    options: readonly T[];
    selected: readonly T[];
    onChange: (next: T[]) => void;
    display?: (value: T) => string;
    swatch?: (value: T) => string;
}) {
    const set = new Set(selected);
    return (
        <div className="space-y-2" role="group" aria-label={label}>
            <span className="block text-[0.8125rem] text-fg-muted">{label}</span>
            <div className="flex flex-wrap gap-1.5">
                {options.map((option) => {
                    const on = set.has(option);
                    return (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={on}
                            onClick={() => onChange(options.filter((o) => (o === option ? !on : set.has(o))))}
                            className={cn(
                                "no-drag inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs outline-none",
                                "transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                                on ? "bg-accent-subtle font-semibold text-accent" : "bg-panel-alt text-fg-muted hover:text-fg",
                            )}
                        >
                            {swatch && (
                                <span
                                    className="size-2.5 rounded-full ring-1 ring-fg/20"
                                    style={{ background: swatch(option) }}
                                    aria-hidden
                                />
                            )}
                            {display ? display(option) : option}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
