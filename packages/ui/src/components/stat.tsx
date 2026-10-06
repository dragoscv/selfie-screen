import NumberFlow from "@number-flow/react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface StatProps {
    label: ReactNode;
    value: number;
    /** Rendered after the value, e.g. a currency symbol or unit. */
    suffix?: string;
    prefix?: string;
    icon?: ReactNode;
    tint?: string;
    /** Compact notation for large counts (1.2K). */
    compact?: boolean;
    locale?: string;
    fractionDigits?: number;
    className?: string;
}

/**
 * An animated metric tile.
 *
 * Numbers roll rather than snap, which makes a live counter legible while it
 * changes — a hard swap at 5 updates/sec is unreadable. Disabled automatically
 * under reduced motion by NumberFlow itself.
 */
export function Stat({
    label,
    value,
    suffix,
    prefix,
    icon,
    tint,
    compact = false,
    locale = "en",
    fractionDigits,
    className,
}: StatProps) {
    return (
        <div
            className={cn("surface rounded-panel p-3.5", className)}
            style={tint ? ({ "--tint": tint } as React.CSSProperties) : undefined}
        >
            <div className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-fg-muted">
                {icon && (
                    <span className="[&_svg]:size-3" style={{ color: tint }} aria-hidden>
                        {icon}
                    </span>
                )}
                <span className="truncate">{label}</span>
            </div>
            <div
                className="mt-1 text-2xl font-bold tabular-nums leading-none"
                style={{ color: tint ?? "var(--fg)" }}
            >
                <NumberFlow
                    value={value}
                    locales={locale}
                    prefix={prefix}
                    suffix={suffix}
                    format={{
                        notation: compact && value >= 10_000 ? "compact" : "standard",
                        maximumFractionDigits: fractionDigits ?? (compact ? 1 : 0),
                        minimumFractionDigits: fractionDigits ?? 0,
                    }}
                />
            </div>
        </div>
    );
}

/** A dense inline metric for headers and toolbars. */
export function InlineStat({
    label,
    value,
    tint,
    locale = "en",
    compact = true,
}: Pick<StatProps, "label" | "value" | "tint" | "locale" | "compact">) {
    return (
        <div className="flex flex-col items-center gap-0.5">
            <span
                className="text-base font-bold tabular-nums leading-none"
                style={{ color: tint ?? "var(--fg)" }}
            >
                <NumberFlow
                    value={value}
                    locales={locale}
                    format={{
                        notation: compact && value >= 10_000 ? "compact" : "standard",
                        maximumFractionDigits: 1,
                    }}
                />
            </span>
            <span className="text-[0.5625rem] font-semibold uppercase tracking-wide text-fg-subtle">
                {label}
            </span>
        </div>
    );
}
