import { aggregate, tickerLabel, type ChatEvent, type ChatKind } from "@tiksee/core";
import { ChatRow, ChatSkeleton, EmptyState, LoadingPulse, TickerRow, cn } from "@tiksee/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, MessageSquare, WifiOff } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../store/app-store.js";

export interface ChatFeedProps {
    events: ChatEvent[];
    state: "offline" | "connecting" | "live" | "reconnecting" | "ended" | "error";
    search?: string;
    kindFilter?: ReadonlySet<ChatKind>;
    onSelectUser?: (uniqueId: string) => void;
    compact?: boolean;
    /** Which collapse settings apply: the main feed's or the overlay's. */
    surface?: "feed" | "overlay";
    className?: string;
}

/** Bottom slop within which we still consider the user "at the latest". */
const STICK_THRESHOLD_PX = 48;

/**
 * The live chat feed.
 *
 * Virtualised with dynamic measurement because rows vary in height (1–4 text
 * lines). New messages append at the bottom and auto-scroll, but only while
 * the user is already at the bottom — scrolling up to read must never be
 * yanked away, which is the single most important interaction detail here.
 */
export function ChatFeed({
    events,
    state,
    search = "",
    kindFilter,
    onSelectUser,
    compact = false,
    surface = "feed",
    className,
}: ChatFeedProps) {
    const { t, i18n } = useTranslation();
    const display = useAppStore((s) => s.settings.display);
    const speakingId = useAppStore((s) => s.speakingEventId);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [stuck, setStuck] = useState(true);

    // ---- aggregate, then filter ---------------------------------------
    const { rows, joinTicker, likeTicker } = useMemo(() => {
        const overlay = surface === "overlay";
        const result = aggregate(events, {
            collapseJoins: overlay ? display.collapseJoinsOverlay : display.collapseJoinsFeed,
            collapseLikes: overlay ? display.collapseLikesOverlay : display.collapseLikesFeed,
            mergeSameUser: display.mergeSameUser,
        });

        const needle = search.trim().toLowerCase();
        const filtered = result.events.filter((event) => {
            if (kindFilter && kindFilter.size > 0 && !kindFilter.has(event.kind)) return false;
            if (needle === "") return true;
            return (
                event.text.toLowerCase().includes(needle) ||
                event.user.nickname.toLowerCase().includes(needle) ||
                event.user.uniqueId.toLowerCase().includes(needle)
            );
        });

        return { rows: filtered, joinTicker: result.joinTicker, likeTicker: result.likeTicker };
    }, [events, display, search, kindFilter, surface]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        // Close enough that the scrollbar is honest before rows are measured.
        estimateSize: () => (compact ? 48 : 62),
        overscan: 8,
        getItemKey: (index) => rows[index]?.id ?? index,
    });

    // ---- auto-scroll ---------------------------------------------------
    const scrollToEnd = useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        element.scrollTop = element.scrollHeight;
    }, []);

    const onScroll = useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setStuck(distance <= STICK_THRESHOLD_PX);
    }, []);

    // Layout effect so the jump happens in the same frame the row is painted;
    // a passive effect produces a visible one-frame flash of the old position.
    useLayoutEffect(() => {
        if (stuck) scrollToEnd();
    }, [rows.length, stuck, scrollToEnd]);

    useEffect(() => {
        // Row heights settle after images load and text wraps; re-pin once.
        if (!stuck) return;
        const id = window.setTimeout(scrollToEnd, 60);
        return () => window.clearTimeout(id);
    }, [rows.length, stuck, scrollToEnd]);

    // ---- empty and loading states --------------------------------------
    if (state === "connecting" || state === "reconnecting") {
        return (
            <div className={cn("flex h-full flex-col justify-end gap-4 p-3", className)}>
                <ChatSkeleton rows={compact ? 4 : 6} />
                <div className="pb-6 pt-2">
                    <LoadingPulse label={t("connection.connecting")} />
                </div>
            </div>
        );
    }

    if (rows.length === 0) {
        const searching = search.trim() !== "" || (kindFilter?.size ?? 0) > 0;
        return (
            <div className={cn("grid h-full place-items-center", className)}>
                {searching ? (
                    <EmptyState
                        icon={<MessageSquare />}
                        title={t("feed.noResults")}
                        description={t("feed.noResultsHint")}
                    />
                ) : state === "live" ? (
                    <EmptyState
                        icon={<MessageSquare />}
                        title={t("feed.empty")}
                        description={t("feed.emptyHint")}
                    />
                ) : (
                    <EmptyState
                        icon={<WifiOff />}
                        title={t("feed.offline")}
                        description={t("feed.offlineHint")}
                    />
                )}
            </div>
        );
    }

    const items = virtualizer.getVirtualItems();

    return (
        <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
                role="log"
                aria-live="polite"
                aria-label={t("feed.title")}
            >
                <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((item) => {
                        const event = rows[item.index];
                        if (!event) return null;
                        return (
                            <div
                                key={item.key}
                                ref={virtualizer.measureElement}
                                data-index={item.index}
                                className="absolute left-0 top-0 w-full pb-1.5"
                                style={{ transform: `translateY(${item.start}px)` }}
                            >
                                <ChatRow
                                    event={event}
                                    speaking={speakingId === event.id}
                                    showAvatar={display.showAvatars}
                                    showTimestamp={display.showTimestamps}
                                    compact={compact}
                                    locale={i18n.language}
                                    highlight={search}
                                    onSelectUser={onSelectUser}
                                />
                            </div>
                        );
                    })}
                </div>
            </div>

            {(joinTicker || likeTicker) && (
                <div className="shrink-0 space-y-1 pb-2">
                    <AnimatePresence initial={false}>
                        {joinTicker && (
                            <TickerRow
                                key="join"
                                kind="join"
                                label={tickerLabel(joinTicker, t("feed.ticker.joined"))}
                            />
                        )}
                        {likeTicker && (
                            <TickerRow
                                key="like"
                                kind="like"
                                label={tickerLabel(likeTicker, t("feed.ticker.liked"))}
                            />
                        )}
                    </AnimatePresence>
                </div>
            )}

            <AnimatePresence>
                {!stuck && (
                    <motion.button
                        type="button"
                        initial={{ opacity: 0, y: 8, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.95 }}
                        onClick={() => {
                            setStuck(true);
                            scrollToEnd();
                        }}
                        className={cn(
                            "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5",
                            "rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg shadow-lg",
                            "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                    >
                        <ArrowDown className="size-3.5" />
                        {t("feed.jumpToLatest")}
                    </motion.button>
                )}
            </AnimatePresence>
        </div>
    );
}
