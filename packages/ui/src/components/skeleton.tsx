import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/cn.js";

/**
 * Shimmer placeholder.
 *
 * Uses a moving gradient rather than a pulsing opacity: at a glance it reads
 * as "loading" instead of "disabled", and it keeps working under a translucent
 * mica surface where an opacity pulse would be nearly invisible.
 */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
    return (
        <div
            aria-hidden
            className={cn(
                "relative overflow-hidden rounded-chip bg-panel-alt",
                "after:absolute after:inset-0 after:-translate-x-full",
                "after:bg-gradient-to-r after:from-transparent after:via-fg/[0.07] after:to-transparent",
                "after:animate-[shimmer_1.6s_infinite]",
                "motion-reduce:after:hidden",
                className,
            )}
            {...props}
        />
    );
}

/** A believable skeleton for the chat feed: varied widths, avatar, two lines. */
export function ChatSkeleton({ rows = 6 }: { rows?: number }) {
    // Deterministic widths — random ones would reshuffle on every render and
    // create a distracting flicker.
    const widths = [82, 64, 91, 55, 74, 68, 88, 60];
    return (
        <div className="flex flex-col gap-2" aria-label="Loading messages" aria-busy="true">
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex items-start gap-3 rounded-panel px-3 py-2.5">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-2.5 w-24" />
                        <Skeleton className="h-3" style={{ width: `${widths[index % widths.length]}%` }} />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function StatSkeleton({ count = 4 }: { count?: number }) {
    return (
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-4" aria-busy="true">
            {Array.from({ length: count }, (_, index) => (
                <div key={index} className="surface space-y-2 rounded-panel p-4">
                    <Skeleton className="h-2.5 w-14" />
                    <Skeleton className="h-6 w-20" />
                </div>
            ))}
        </div>
    );
}
