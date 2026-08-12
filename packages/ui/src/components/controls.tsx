import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { useId, useState, type ReactNode } from "react";

import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * SwitchRow
 * ------------------------------------------------------------------ */

export interface SwitchRowProps {
    label: ReactNode;
    description?: ReactNode;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** CSS colour for the checked track; defaults to the accent. */
    tint?: string;
}

export function SwitchRow({
    label,
    description,
    checked,
    onChange,
    disabled,
    tint,
}: SwitchRowProps) {
    const id = useId();
    return (
        <div
            className={cn(
                "flex items-center gap-4 rounded-[--radius-chip] py-1",
                disabled && "opacity-55",
            )}
        >
            <div className="min-w-0 flex-1">
                <label
                    htmlFor={id}
                    className={cn("block text-sm leading-tight text-fg", !disabled && "cursor-pointer")}
                >
                    {label}
                </label>
                {description !== undefined && (
                    <p className="mt-0.5 text-[0.6875rem] leading-snug text-fg-muted">{description}</p>
                )}
            </div>
            <SwitchPrimitive.Root
                id={id}
                checked={checked}
                onCheckedChange={onChange}
                disabled={disabled}
                style={tint ? ({ "--tint": tint } as React.CSSProperties) : undefined}
                className={cn(
                    "no-drag peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center",
                    "rounded-full border-2 border-transparent outline-none",
                    "transition-colors duration-[--dur-fast] ease-[--ease-out]",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                    "disabled:cursor-not-allowed",
                    "data-[state=unchecked]:bg-panel-alt",
                )}
                data-tinted={tint ? "" : undefined}
            >
                <span
                    className="absolute inset-0 rounded-full opacity-0 transition-opacity duration-[--dur-fast] data-[on=true]:opacity-100"
                    data-on={checked}
                    style={{ background: tint ?? "var(--accent)" }}
                    aria-hidden
                />
                <SwitchPrimitive.Thumb
                    className={cn(
                        "pointer-events-none relative z-10 block size-5 rounded-full bg-white shadow-sm",
                        "transition-transform duration-[--dur-fast] ease-[--ease-out]",
                        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
                        "data-[state=unchecked]:bg-fg-subtle",
                    )}
                />
            </SwitchPrimitive.Root>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * SliderRow
 * ------------------------------------------------------------------ */

export interface SliderRowProps {
    label: ReactNode;
    value: number;
    min: number;
    max: number;
    step?: number;
    onCommit: (value: number) => void;
    format?: (value: number) => string;
    tint?: string;
    disabled?: boolean;
}

/**
 * A labelled slider with a live value chip.
 *
 * Drags update local state only and commit on release. Persisting on every
 * pointer move would write hundreds of times per drag — the Android original
 * has the same `onValueChangeFinished` behaviour.
 */
export function SliderRow({
    label,
    value,
    min,
    max,
    step = 0.01,
    onCommit,
    format,
    tint,
    disabled,
}: SliderRowProps) {
    const id = useId();
    // Derived state during render (React's recommended pattern) rather than a
    // sync effect: while dragging we show the local value, and any external
    // change is adopted on the next render once the drag ends. An effect here
    // would cause a cascading re-render on every prop tick.
    const [drag, setDrag] = useState<{ value: number; committedFrom: number } | null>(null);
    const local = drag !== null && drag.committedFrom === value ? drag.value : value;

    const shown = format ? format(local) : String(local);
    const style = tint ? ({ "--tint": tint } as React.CSSProperties) : undefined;

    return (
        <div className={cn("space-y-2", disabled && "opacity-55")} style={style}>
            <div className="flex items-center gap-3">
                <label htmlFor={id} className="flex-1 text-[0.8125rem] text-fg-muted">
                    {label}
                </label>
                <output
                    htmlFor={id}
                    className="rounded-[0.5rem] px-2.5 py-1 text-xs font-bold tabular-nums transition-colors duration-[--dur-normal]"
                    style={{
                        color: tint ?? "var(--accent)",
                        background: "color-mix(in oklab, var(--tint, var(--accent)) 14%, transparent)",
                    }}
                >
                    {shown}
                </output>
            </div>
            <SliderPrimitive.Root
                id={id}
                value={[local]}
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                onValueChange={([next]) => {
                    if (next !== undefined) setDrag({ value: next, committedFrom: value });
                }}
                onValueCommit={([next]) => {
                    setDrag(null);
                    if (next !== undefined) onCommit(next);
                }}
                className="no-drag relative flex h-5 w-full touch-none select-none items-center"
            >
                <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-panel-alt">
                    <SliderPrimitive.Range
                        className="absolute h-full rounded-full"
                        style={{ background: tint ?? "var(--accent)" }}
                    />
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb
                    aria-label={typeof label === "string" ? label : undefined}
                    className={cn(
                        "block size-4 rounded-full border-2 border-bg shadow-md outline-none",
                        "transition-[transform,box-shadow] duration-[--dur-fast] ease-[--ease-out]",
                        "hover:scale-110 active:scale-95",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                    )}
                    style={{ background: tint ?? "var(--accent)" }}
                />
            </SliderPrimitive.Root>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * ChipSelector
 * ------------------------------------------------------------------ */

export interface ChipSelectorProps<T extends string> {
    label?: ReactNode;
    options: readonly T[];
    value: T;
    onSelect: (value: T) => void;
    display?: (value: T) => string;
    tint?: string;
    disabled?: boolean;
}

/** Wrapping radio group rendered as pills — the Android chip selector. */
export function ChipSelector<T extends string>({
    label,
    options,
    value,
    onSelect,
    display,
    tint,
    disabled,
}: ChipSelectorProps<T>) {
    return (
        <div className={cn("space-y-2", disabled && "opacity-55")}>
            {label !== undefined && (
                <span className="block text-[0.8125rem] text-fg-muted">{label}</span>
            )}
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={String(label ?? "")}>
                {options.map((option) => {
                    const selected = option === value;
                    return (
                        <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={disabled}
                            onClick={() => onSelect(option)}
                            className={cn(
                                "no-drag rounded-[--radius-chip] px-3.5 py-2 text-xs outline-none",
                                "transition-all duration-[--dur-fast] ease-[--ease-out]",
                                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                                "disabled:cursor-not-allowed",
                                selected
                                    ? "font-bold"
                                    : "bg-panel-alt font-normal text-fg-muted hover:bg-panel-alt/70 hover:text-fg",
                            )}
                            style={
                                selected
                                    ? {
                                        color: tint ?? "var(--accent)",
                                        background: `color-mix(in oklab, ${tint ?? "var(--accent)"} 18%, transparent)`,
                                        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint ?? "var(--accent)"} 55%, transparent)`,
                                    }
                                    : undefined
                            }
                        >
                            {display ? display(option) : option}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * TextInput
 * ------------------------------------------------------------------ */

export interface TextInputProps {
    label?: ReactNode;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    multiline?: boolean;
    secret?: boolean;
    disabled?: boolean;
    autoComplete?: string;
    /** Rendered below the field; use for validation messages. */
    hint?: ReactNode;
    invalid?: boolean;
}

export function TextInput({
    label,
    value,
    onChange,
    placeholder,
    multiline = false,
    secret = false,
    disabled,
    autoComplete,
    hint,
    invalid,
}: TextInputProps) {
    const id = useId();
    const hintId = `${id}-hint`;
    const shared = cn(
        "no-drag w-full rounded-[--radius-control] bg-panel-alt px-3.5 py-2.5 text-sm text-fg",
        "border border-border outline-none placeholder:text-fg-subtle",
        "transition-[border-color,box-shadow] duration-[--dur-fast]",
        "focus:border-accent focus:ring-2 focus:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-55",
        invalid && "border-danger focus:border-danger focus:ring-danger/30",
    );

    return (
        <div className="space-y-1.5">
            {label !== undefined && (
                <label htmlFor={id} className="block text-[0.8125rem] text-fg-muted">
                    {label}
                </label>
            )}
            {multiline ? (
                <textarea
                    id={id}
                    rows={3}
                    value={value}
                    placeholder={placeholder}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    aria-describedby={hint !== undefined ? hintId : undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={cn(shared, "resize-y leading-relaxed")}
                />
            ) : (
                <input
                    id={id}
                    type={secret ? "password" : "text"}
                    value={value}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoComplete={autoComplete ?? (secret ? "off" : undefined)}
                    spellCheck={secret ? false : undefined}
                    aria-invalid={invalid || undefined}
                    aria-describedby={hint !== undefined ? hintId : undefined}
                    onChange={(event) => onChange(event.target.value)}
                    className={shared}
                />
            )}
            {hint !== undefined && (
                <p id={hintId} className={cn("text-[0.6875rem]", invalid ? "text-danger" : "text-fg-muted")}>
                    {hint}
                </p>
            )}
        </div>
    );
}
