import { AnimatePresence, motion } from "motion/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { transitions } from "../lib/motion.js";

/* ------------------------------------------------------------------ *
 * StatusPill
 * ------------------------------------------------------------------ */

export interface StatusPillProps {
    children: ReactNode;
    tone?: "neutral" | "accent" | "success" | "warning" | "danger";
    /** Adds a breathing dot; use for genuinely live states only. */
    pulse?: boolean;
}

export function StatusPill({ children, tone = "neutral", pulse = false }: StatusPillProps) {
    const color = {
        neutral: "var(--fg-muted)",
        accent: "var(--accent)",
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
    }[tone];
    return (
        <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.625rem] font-bold uppercase tracking-wide"
            style={{
                color,
                background: `color-mix(in oklab, ${color} 14%, transparent)`,
            }}
        >
            <span className="relative flex size-1.5">
                {pulse && (
                    <span
                        className="absolute inline-flex size-full animate-ping rounded-full opacity-70 motion-reduce:hidden"
                        style={{ background: color }}
                    />
                )}
                <span className="relative inline-flex size-1.5 rounded-full" style={{ background: color }} />
            </span>
            {children}
        </span>
    );
}

/* ------------------------------------------------------------------ *
 * Reveal
 * ------------------------------------------------------------------ */

/** Height-animated disclosure, used for settings that depend on a toggle. */
export function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
    return (
        <AnimatePresence initial={false}>
            {show && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={transitions.fast}
                    className="overflow-hidden"
                >
                    <div className="flex flex-col gap-3 pt-3">{children}</div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

/* ------------------------------------------------------------------ *
 * EmptyState
 * ------------------------------------------------------------------ */

export interface EmptyStateProps {
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    className?: string;
}

/**
 * Every list and route gets one of these. A blank region reads as a bug;
 * a designed empty state reads as a state.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
                className,
            )}
        >
            {icon && (
                <div
                    className="grid size-14 place-items-center rounded-2xl bg-accent-subtle text-accent [&_svg]:size-6"
                    aria-hidden
                >
                    {icon}
                </div>
            )}
            <div className="space-y-1">
                <p className="text-sm font-semibold text-fg">{title}</p>
                {description !== undefined && (
                    <p className="measure mx-auto text-pretty text-xs leading-relaxed text-fg-muted">
                        {description}
                    </p>
                )}
            </div>
            {action}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * LoadingPulse
 * ------------------------------------------------------------------ */

/** The "waiting for something to happen" indicator, ported from Android. */
export function LoadingPulse({ label }: { label?: ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-3" role="status">
            <div className="relative grid size-9 place-items-center">
                <motion.span
                    className="absolute inset-0 rounded-full bg-accent-subtle"
                    animate={{ scale: [0.85, 1.12, 0.85] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                />
                <span className="relative size-2.5 rounded-full bg-accent" />
            </div>
            {label !== undefined && <p className="text-xs text-fg-muted">{label}</p>}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * SpeakingBars
 * ------------------------------------------------------------------ */

/** Three animated bars shown while the voice engine is speaking. */
export function SpeakingBars({ level = 0.6 }: { level?: number }) {
    const amplitude = Math.max(0.25, Math.min(1, level));
    return (
        <span className="inline-flex items-end gap-[2px]" aria-hidden>
            {[0, 1, 2].map((index) => (
                <motion.span
                    key={index}
                    className="w-[2.5px] rounded-full bg-success"
                    animate={{ height: [4, 4 + 9 * amplitude, 4] }}
                    transition={{
                        duration: 0.38 + index * 0.09,
                        repeat: Infinity,
                        ease: "easeInOut",
                    }}
                />
            ))}
        </span>
    );
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export interface ProgressProps extends ComponentPropsWithoutRef<"div"> {
    /** 0..1. Omit for an indeterminate bar. */
    value?: number;
    label?: string;
}

export function Progress({ value, label, className, ...props }: ProgressProps) {
    const determinate = value !== undefined;
    const pct = Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100);
    return (
        <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={determinate ? pct : undefined}
            aria-label={label}
            className={cn("h-1 w-full overflow-hidden rounded-full bg-panel-alt", className)}
            {...props}
        >
            {determinate ? (
                <motion.div
                    className="h-full rounded-full bg-accent"
                    animate={{ width: `${pct}%` }}
                    transition={transitions.normal}
                />
            ) : (
                <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
            )}
        </div>
    );
}
