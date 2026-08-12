import type { ChatKind } from "@tiksee/core";
import { CHAT_KINDS, diamondsToUsd, formatDuration } from "@tiksee/core";
import { Button, Card, InlineStat, Stat, cn } from "@tiksee/ui";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
    Coins,
    Eye,
    Gift,
    Heart,
    MessageSquare,
    Search,
    Share2,
    Trash2,
    UserPlus,
    Users,
    X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatFeed } from "../components/chat-feed.js";
import { ErrorBoundary } from "../components/error-boundary.js";
import { MAIN_STREAM, selectEvents, selectStats, selectStatus, useAppStore } from "../store/app-store.js";

const KIND_ICON: Record<ChatKind, typeof MessageSquare> = {
    chat: MessageSquare,
    gift: Gift,
    follow: UserPlus,
    join: Users,
    like: Heart,
    share: Share2,
};

export function LiveRoute() {
    const { t, i18n } = useTranslation();
    const events = useAppStore(selectEvents(MAIN_STREAM));
    const status = useAppStore(selectStatus(MAIN_STREAM));
    const stats = useAppStore(selectStats(MAIN_STREAM));
    const clearEvents = useAppStore((s) => s.clearEvents);
    const trackEarnings = useAppStore((s) => s.settings.data.trackEarnings);
    const diamondRate = useAppStore((s) => s.settings.data.diamondRateUsd);

    const [search, setSearch] = useState("");
    const [kinds, setKinds] = useState<ReadonlySet<ChatKind>>(new Set());
    // A 1Hz clock that only ticks while live. `now` is the external system
    // being subscribed to; the elapsed value is derived during render, so no
    // setState-in-effect cascade is needed.
    const [now, setNow] = useState(() => Date.now());
    const live = status.state === "live" && status.connectedAt !== undefined;

    useEffect(() => {
        if (!live) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [live]);

    const elapsed = live && status.connectedAt ? Math.max(0, now - status.connectedAt) : 0;

    const messagesPerMinute = useMemo(() => {
        if (elapsed < 5_000) return 0;
        return Math.round((stats.messages / (elapsed / 60_000)) * 10) / 10;
    }, [stats.messages, elapsed]);

    const toggleKind = (kind: ChatKind) => {
        setKinds((current) => {
            const next = new Set(current);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
        });
    };

    return (
        <Group orientation="horizontal" className="flex h-full">
            <Panel defaultSize="62%" minSize="28%" className="flex min-h-0 flex-col">
                <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
                    <h1 className="text-sm font-semibold text-fg">{t("feed.title")}</h1>

                    <div className="relative ml-auto">
                        <Search
                            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
                            aria-hidden
                        />
                        <input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t("feed.searchPlaceholder")}
                            aria-label={t("feed.search")}
                            className={cn(
                                "no-drag h-8 w-52 rounded-[--radius-chip] bg-panel-alt pl-8 pr-7 text-xs text-fg",
                                "border border-border outline-none placeholder:text-fg-subtle",
                                "focus:border-accent focus:ring-2 focus:ring-ring/40",
                            )}
                        />
                        {search !== "" && (
                            <button
                                type="button"
                                onClick={() => setSearch("")}
                                aria-label={t("common.close")}
                                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-subtle hover:text-fg"
                            >
                                <X className="size-3" />
                            </button>
                        )}
                    </div>

                    <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("feed.clear")}
                        aria-label={t("feed.clear")}
                        onClick={() => clearEvents(MAIN_STREAM)}
                    >
                        <Trash2 />
                    </Button>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
                    {CHAT_KINDS.map((kind) => {
                        const Icon = KIND_ICON[kind];
                        const active = kinds.has(kind);
                        return (
                            <button
                                key={kind}
                                type="button"
                                onClick={() => toggleKind(kind)}
                                aria-pressed={active}
                                className={cn(
                                    "no-drag inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
                                    "text-[0.6875rem] font-medium outline-none transition-all duration-[--dur-fast]",
                                    "focus-visible:ring-2 focus-visible:ring-ring",
                                    active
                                        ? "text-[var(--k)] [background:color-mix(in_oklab,var(--k)_18%,transparent)]"
                                        : "bg-panel-alt text-fg-muted hover:text-fg",
                                )}
                                style={{ "--k": `var(--kind-${kind})` } as React.CSSProperties}
                            >
                                <Icon className="size-3" />
                                {t(`feed.kinds.${kind}`)}
                            </button>
                        );
                    })}
                </div>

                <ErrorBoundary area="chat feed">
                    <ChatFeed
                        events={events}
                        state={status.state}
                        search={search}
                        kindFilter={kinds}
                        className="min-h-0 flex-1"
                    />
                </ErrorBoundary>
            </Panel>

            <Separator
                className={cn(
                    "group relative w-1.5 shrink-0 cursor-col-resize outline-none",
                    "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2",
                    "before:bg-border before:transition-colors",
                    "hover:before:bg-accent focus-visible:before:bg-accent",
                )}
            />

            <Panel defaultSize="38%" minSize="22%" className="min-h-0">
                <div className="@container h-full overflow-y-auto px-4 py-3">
                    <div className="flex flex-col gap-3">
                        <Card title={t("analytics.title")} icon={<Eye />} flush>
                            <div className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
                                <InlineStat
                                    label={t("stats.viewers")}
                                    value={status.viewerCount ?? 0}
                                    locale={i18n.language}
                                />
                                <InlineStat
                                    label={t("stats.uniqueViewers")}
                                    value={stats.uniqueViewers}
                                    locale={i18n.language}
                                />
                                <InlineStat
                                    label={t("stats.perMinute")}
                                    value={messagesPerMinute}
                                    locale={i18n.language}
                                    compact={false}
                                />
                            </div>
                            <p className="mt-3 text-center text-[0.625rem] uppercase tracking-wide text-fg-subtle">
                                {t("stats.duration")} · {formatDuration(elapsed)}
                            </p>
                        </Card>

                        <div className="grid grid-cols-2 gap-2 @lg:grid-cols-2 @2xl:grid-cols-4">
                            <Stat
                                label={t("stats.messages")}
                                value={stats.messages}
                                icon={<MessageSquare />}
                                tint="var(--kind-chat)"
                                compact
                                locale={i18n.language}
                            />
                            <Stat
                                label={t("stats.gifts")}
                                value={stats.gifts}
                                icon={<Gift />}
                                tint="var(--kind-gift)"
                                compact
                                locale={i18n.language}
                            />
                            <Stat
                                label={t("stats.follows")}
                                value={stats.follows}
                                icon={<UserPlus />}
                                tint="var(--kind-follow)"
                                compact
                                locale={i18n.language}
                            />
                            <Stat
                                label={t("stats.likes")}
                                value={stats.likes}
                                icon={<Heart />}
                                tint="var(--kind-like)"
                                compact
                                locale={i18n.language}
                            />
                        </div>

                        {trackEarnings && (
                            <div className="grid grid-cols-2 gap-2">
                                <Stat
                                    label={t("stats.diamonds")}
                                    value={stats.diamonds}
                                    icon={<Coins />}
                                    tint="var(--kind-gift)"
                                    compact
                                    locale={i18n.language}
                                />
                                <Stat
                                    label={t("stats.earnings")}
                                    value={diamondsToUsd(stats.diamonds, diamondRate)}
                                    prefix="$"
                                    fractionDigits={2}
                                    icon={<Coins />}
                                    tint="var(--success)"
                                    locale={i18n.language}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </Panel>
        </Group>
    );
}
