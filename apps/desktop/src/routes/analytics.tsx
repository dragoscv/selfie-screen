import { CHAT_KINDS, eventDiamonds, type ChatEvent, type ChatKind } from "@tiksee/core";
import { Card, EmptyState } from "@tiksee/ui";
import { BarChart3, PieChart as PieIcon, TrendingUp } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ErrorBoundary } from "../components/error-boundary.js";
import { MAIN_STREAM, selectEvents, useAppStore } from "../store/app-store.js";

// Recharts is heavy and only this route needs it, so each chart is a separate
// lazy component sharing one chunk.
const ActivityChart = lazy(() =>
    import("../components/charts.js").then((m) => ({ default: m.ActivityChart })),
);
const BreakdownChart = lazy(() =>
    import("../components/charts.js").then((m) => ({ default: m.BreakdownChart })),
);
const GiftersChart = lazy(() =>
    import("../components/charts.js").then((m) => ({ default: m.GiftersChart })),
);

const BUCKET_MS = 60_000;

export function AnalyticsRoute() {
    const { t } = useTranslation();
    const events = useAppStore(selectEvents(MAIN_STREAM));

    const { timeline, breakdown, gifters } = useMemo(() => buildSeries(events), [events]);

    if (events.length === 0) {
        return (
            <div className="grid h-full place-items-center">
                <EmptyState icon={<BarChart3 />} title={t("analytics.empty")} description={t("analytics.emptyHint")} />
            </div>
        );
    }

    return (
        <div className="@container h-full overflow-y-auto p-5">
            <div className="mx-auto grid max-w-[110rem] gap-3 @4xl:grid-cols-2">
                <Card
                    title={t("analytics.activity")}
                    subtitle={t("analytics.activityHint")}
                    icon={<TrendingUp />}
                    className="@4xl:col-span-2"
                >
                    <ErrorBoundary area="activity chart">
                        <Suspense fallback={<div className="h-56 animate-pulse rounded-[--radius-panel] bg-panel-alt" />}>
                            <ActivityChart data={timeline} />
                        </Suspense>
                    </ErrorBoundary>
                </Card>

                <Card title={t("analytics.breakdown")} icon={<PieIcon />} tint="var(--kind-join)">
                    <ErrorBoundary area="breakdown chart">
                        <Suspense fallback={<div className="h-56 animate-pulse rounded-[--radius-panel] bg-panel-alt" />}>
                            <BreakdownChart data={breakdown} />
                        </Suspense>
                    </ErrorBoundary>
                </Card>

                <Card title={t("analytics.topGifters")} icon={<BarChart3 />} tint="var(--kind-gift)">
                    {gifters.length === 0 ? (
                        <p className="text-xs text-fg-subtle">{t("analytics.noGifts")}</p>
                    ) : (
                        <ErrorBoundary area="gifters chart">
                            <Suspense fallback={<div className="h-56 animate-pulse rounded-[--radius-panel] bg-panel-alt" />}>
                                <GiftersChart data={gifters} />
                            </Suspense>
                        </ErrorBoundary>
                    )}
                </Card>
            </div>
        </div>
    );
}

export interface TimelinePoint {
    t: number;
    label: string;
    messages: number;
    gifts: number;
}

export interface BreakdownSlice {
    kind: ChatKind;
    value: number;
}

export interface GifterBar {
    name: string;
    diamonds: number;
}

function buildSeries(events: ChatEvent[]): {
    timeline: TimelinePoint[];
    breakdown: BreakdownSlice[];
    gifters: GifterBar[];
} {
    if (events.length === 0) return { timeline: [], breakdown: [], gifters: [] };

    const buckets = new Map<number, TimelinePoint>();
    const counts = new Map<ChatKind, number>();
    const diamonds = new Map<string, number>();

    for (const event of events) {
        const bucket = Math.floor(event.at / BUCKET_MS) * BUCKET_MS;
        let point = buckets.get(bucket);
        if (!point) {
            point = {
                t: bucket,
                label: new Date(bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                messages: 0,
                gifts: 0,
            };
            buckets.set(bucket, point);
        }
        if (event.kind === "chat") point.messages += 1;
        if (event.kind === "gift") {
            point.gifts += 1;
            const name = event.user.nickname || event.user.uniqueId;
            diamonds.set(name, (diamonds.get(name) ?? 0) + eventDiamonds(event));
        }
        counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
    }

    return {
        timeline: [...buckets.values()].sort((a, b) => a.t - b.t),
        breakdown: CHAT_KINDS.map((kind) => ({ kind, value: counts.get(kind) ?? 0 })).filter(
            (slice) => slice.value > 0,
        ),
        gifters: [...diamonds.entries()]
            .map(([name, value]) => ({ name, diamonds: value }))
            .sort((a, b) => b.diamonds - a.diamonds)
            .slice(0, 8),
    };
}
