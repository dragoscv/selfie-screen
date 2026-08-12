import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../lib/cn.js";

// `title` is omitted from the native props: the HTML attribute is a string
// tooltip, whereas ours is renderable content.
export interface CardProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
    title?: ReactNode;
    subtitle?: ReactNode;
    icon?: ReactNode;
    /** CSS colour for the icon tile and title rule. Defaults to the accent. */
    tint?: string;
    actions?: ReactNode;
    /** Removes the inner padding for edge-to-edge content such as lists. */
    flush?: boolean;
}

/**
 * The primary content container, ported from the Android `SettingsCard`:
 * a tinted icon tile, a title/subtitle pair, and a stacked content area.
 */
export function Card({
    title,
    subtitle,
    icon,
    tint,
    actions,
    flush = false,
    className,
    children,
    ...props
}: CardProps) {
    const style = tint ? ({ "--tint": tint } as React.CSSProperties) : undefined;
    const hasHeader = title !== undefined || icon !== undefined || actions !== undefined;

    return (
        <section
            className={cn("surface rounded-[--radius-card]", flush ? "p-0" : "p-[--space-card]", className)}
            style={style}
            {...props}
        >
            {hasHeader && (
                <header
                    className={cn(
                        "flex items-start gap-3",
                        flush && "p-[--space-card] pb-3",
                        !flush && children !== undefined && "mb-3.5",
                    )}
                >
                    {icon && (
                        <span
                            className="grid size-8 shrink-0 place-items-center rounded-[0.625rem] [&_svg]:size-[1.0625rem]"
                            style={{
                                background: "color-mix(in oklab, var(--tint, var(--accent)) 14%, transparent)",
                                color: "var(--tint, var(--accent))",
                            }}
                            aria-hidden
                        >
                            {icon}
                        </span>
                    )}
                    <div className="min-w-0 flex-1">
                        {title !== undefined && (
                            <h2 className="truncate text-[0.9375rem] font-semibold leading-tight text-fg">
                                {title}
                            </h2>
                        )}
                        {subtitle !== undefined && (
                            <p className="mt-0.5 text-[0.6875rem] leading-snug text-fg-muted">{subtitle}</p>
                        )}
                    </div>
                    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
                </header>
            )}
            {children !== undefined && (
                <div className={cn("flex flex-col gap-3", flush && "px-[--space-card] pb-[--space-card]")}>
                    {children}
                </div>
            )}
        </section>
    );
}
