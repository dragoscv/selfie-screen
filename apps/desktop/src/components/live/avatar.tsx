import { initialOf } from "@tiksee/core";
import { cn } from "@tiksee/ui";
import { useState } from "react";

/** Viewer avatar with an initial fallback for missing or broken images. */
export function Avatar({ url, name, className }: { url?: string | undefined; name: string; className?: string }) {
    const [failed, setFailed] = useState(false);
    const base = cn("shrink-0 rounded-full bg-panel-alt object-cover", className ?? "size-8");
    if (url && !failed) {
        return <img src={url} alt="" className={base} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
    }
    return (
        <span className={cn(base, "grid place-items-center text-xs font-bold text-fg-muted")} aria-hidden>
            {initialOf(name)}
        </span>
    );
}
