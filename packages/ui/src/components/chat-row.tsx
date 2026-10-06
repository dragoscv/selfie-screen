import { formatTime, initialOf, type ChatEvent, type ChatKind } from "@tiksee/core";
import { motion } from "motion/react";
import { memo, useState } from "react";

import { cn } from "../lib/cn.js";
import { transitions } from "../lib/motion.js";

/** CSS variable per kind. The palette is fixed — these encode meaning. */
const KIND_VAR: Readonly<Record<ChatKind, string>> = {
    chat: "var(--kind-chat)",
    gift: "var(--kind-gift)",
    follow: "var(--kind-follow)",
    join: "var(--kind-join)",
    like: "var(--kind-like)",
    share: "var(--kind-share)",
};

export interface ChatRowProps {
    event: ChatEvent;
    /** Highlights the row currently being read aloud. */
    speaking?: boolean;
    showAvatar?: boolean;
    showTimestamp?: boolean;
    compact?: boolean;
    locale?: string;
    /** Substring to highlight, used by chat search. */
    highlight?: string;
    onSelectUser?: (uniqueId: string) => void;
}

function ChatRowImpl({
    event,
    speaking = false,
    showAvatar = true,
    showTimestamp = true,
    compact = false,
    locale = "en",
    highlight,
    onSelectUser,
}: ChatRowProps) {
    const tint = KIND_VAR[event.kind];

    return (
        <motion.article
            layout="position"
            initial={{ opacity: 0, x: -10, scale: 0.99 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={transitions.normal}
            style={{ "--tint": tint } as React.CSSProperties}
            className={cn(
                "group relative grid items-start gap-2.5 rounded-panel",
                compact ? "px-2.5 py-1.5" : "px-3 py-2",
                showAvatar ? "grid-cols-[3px_auto_1fr_auto]" : "grid-cols-[3px_1fr_auto]",
                "transition-colors duration-(--dur-normal)",
                speaking
                    ? "bg-[color-mix(in_oklab,var(--tint)_22%,transparent)]"
                    : "bg-fg/[0.035] hover:bg-fg/[0.06]",
            )}
            data-kind={event.kind}
            data-speaking={speaking || undefined}
        >
            {/* Kind rail — the primary at-a-glance signal. */}
            <span
                className={cn(
                    "self-stretch rounded-full transition-all duration-(--dur-normal)",
                    speaking ? "min-h-8" : "min-h-5",
                )}
                style={{ background: tint }}
                aria-hidden
            />

            {showAvatar && <Avatar event={event} tint={tint} />}

            <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                    <button
                        type="button"
                        onClick={onSelectUser ? () => onSelectUser(event.user.uniqueId) : undefined}
                        disabled={!onSelectUser}
                        className={cn(
                            "truncate text-[0.8125rem] font-bold leading-tight",
                            onSelectUser && "cursor-pointer hover:underline",
                            "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        style={{ color: tint }}
                        title={event.user.uniqueId ? `@${event.user.uniqueId}` : undefined}
                    >
                        {event.user.nickname}
                    </button>
                    {event.replay && (
                        <span className="shrink-0 rounded bg-fg/10 px-1 text-[0.5625rem] font-semibold uppercase text-fg-subtle">
                            replay
                        </span>
                    )}
                </div>
                <p
                    className={cn(
                        "break-words text-[0.875rem] leading-snug text-fg",
                        compact ? "line-clamp-2" : "line-clamp-4",
                    )}
                >
                    {highlight ? <Highlighted text={event.text} query={highlight} /> : event.text}
                </p>
            </div>

            {showTimestamp && (
                <time
                    dateTime={new Date(event.at).toISOString()}
                    className="shrink-0 pt-0.5 text-[0.625rem] tabular-nums text-fg-subtle"
                >
                    {formatTime(event.at, locale)}
                </time>
            )}
        </motion.article>
    );
}

function Avatar({ event, tint }: { event: ChatEvent; tint: string }) {
    const [failed, setFailed] = useState(false);
    const url = event.user.avatarUrl;

    if (!url || failed) {
        return (
            <span
                className="grid size-8 shrink-0 place-items-center rounded-full text-[0.8125rem] font-bold"
                style={{
                    color: tint,
                    background: "color-mix(in oklab, var(--tint) 22%, transparent)",
                }}
                aria-hidden
            >
                {initialOf(event.user.nickname)}
            </span>
        );
    }

    return (
        <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            // A dead CDN URL must degrade to the initial, not a broken-image icon.
            onError={() => setFailed(true)}
            className="size-8 shrink-0 rounded-full bg-panel-alt object-cover"
        />
    );
}

/** Case-insensitive substring highlight for chat search. */
function Highlighted({ text, query }: { text: string; query: string }) {
    const needle = query.trim();
    if (needle === "") return <>{text}</>;

    const lower = text.toLowerCase();
    const target = needle.toLowerCase();
    const parts: React.ReactNode[] = [];
    let cursor = 0;

    for (; ;) {
        const index = lower.indexOf(target, cursor);
        if (index === -1) break;
        if (index > cursor) parts.push(text.slice(cursor, index));
        parts.push(
            <mark key={index} className="rounded bg-warning/30 px-0.5 text-fg">
                {text.slice(index, index + needle.length)}
            </mark>,
        );
        cursor = index + needle.length;
    }
    parts.push(text.slice(cursor));
    return <>{parts}</>;
}

/**
 * Memoised: the feed re-renders on every batch, but a given row's content is
 * immutable. Only `speaking` and `highlight` can change for an existing row.
 */
export const ChatRow = memo(ChatRowImpl, (prev, next) => {
    return (
        prev.event.id === next.event.id &&
        prev.speaking === next.speaking &&
        prev.highlight === next.highlight &&
        prev.showAvatar === next.showAvatar &&
        prev.showTimestamp === next.showTimestamp &&
        prev.compact === next.compact &&
        prev.locale === next.locale
    );
});

/* ------------------------------------------------------------------ *
 * TickerRow
 * ------------------------------------------------------------------ */

export function TickerRow({ kind, label }: { kind: ChatKind; label: string }) {
    const tint = KIND_VAR[kind];
    return (
        <motion.div
            layout="position"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={transitions.fast}
            className="mx-3 flex items-center gap-2 rounded-chip px-2.5 py-1.5"
            style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)` }}
        >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: tint }} aria-hidden />
            <span
                className="truncate text-[0.6875rem] font-semibold"
                style={{ color: tint }}
            >
                {label}
            </span>
        </motion.div>
    );
}
