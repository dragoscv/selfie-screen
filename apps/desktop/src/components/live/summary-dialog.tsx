import { formatDuration, formatTime, type ExportFormat, type SessionSummary } from "@tiksee/core";
import { Button, EmptyState, LoadingPulse, StatusPill } from "@tiksee/ui";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, FileText, Gift, Star, TrendingUp, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { summaryFileName } from "../../lib/summary.js";
import { sidecarClient } from "../../lib/sidecar-client.js";
import { useAppStore } from "../../store/app-store.js";

const MOMENT_ICON = { gift: Gift, highlight: Star, spike: TrendingUp } as const;

async function exportSummary(summary: SessionSummary, format: ExportFormat, title: string): Promise<void> {
    const path = await save({
        title,
        defaultPath: summaryFileName(summary.session, format),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    sidecarClient.send({ type: "summaryExport", sessionId: summary.session.id, format, path });
}

function SummaryBody({ summary }: { summary: SessionSummary }) {
    const { t, i18n } = useTranslation();
    const nf = new Intl.NumberFormat(i18n.language);
    const stats: Array<[string, number]> = [
        ["messages", summary.stats.messages],
        ["gifts", summary.stats.gifts],
        ["diamonds", summary.stats.diamonds],
        ["follows", summary.stats.follows],
        ["likes", summary.stats.likes],
        ["shares", summary.stats.shares],
        ["uniqueViewers", summary.stats.uniqueViewers],
        ["peak", summary.stats.peakViewers],
    ];

    return (
        <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {stats.map(([key, value]) => (
                    <div key={key} className="rounded-[--radius-chip] bg-panel-alt px-3 py-2">
                        <dt className="text-[0.625rem] uppercase tracking-wide text-fg-muted">{t(`stats.${key}`)}</dt>
                        <dd className="text-lg font-bold tabular-nums text-fg">{nf.format(value)}</dd>
                    </div>
                ))}
            </dl>

            <section aria-labelledby="summary-moments">
                <h3 id="summary-moments" className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {t("summary.moments")}
                </h3>
                {summary.moments.length === 0 ? (
                    <p className="text-xs text-fg-subtle">{t("summary.noMoments")}</p>
                ) : (
                    <ol className="flex flex-col gap-1.5">
                        {summary.moments.map((moment, i) => {
                            const Icon = MOMENT_ICON[moment.kind];
                            return (
                                <li key={`${moment.at}-${i}`} className="flex items-start gap-2 text-xs">
                                    <span className="w-11 shrink-0 tabular-nums text-fg-subtle">{formatTime(moment.at, i18n.language)}</span>
                                    <Icon className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
                                    <span className="sr-only">{t(`summary.kinds.${moment.kind}`)}:</span>
                                    <span className="min-w-0 flex-1 text-fg">
                                        {moment.kind === "spike"
                                            ? t("summary.spike", { count: moment.value })
                                            : moment.kind === "gift"
                                              ? t("summary.gift", { name: moment.title, diamonds: nf.format(moment.value), detail: moment.detail })
                                              : moment.title}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                )}
            </section>

            <section aria-labelledby="summary-viewers">
                <h3 id="summary-viewers" className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                    {t("summary.topViewers")}
                </h3>
                {summary.topViewers.length === 0 ? (
                    <p className="text-xs text-fg-subtle">{t("summary.noViewers")}</p>
                ) : (
                    <table className="w-full text-left text-xs">
                        <thead className="text-fg-muted">
                            <tr>
                                <th scope="col" className="py-1 font-medium">{t("summary.viewer")}</th>
                                <th scope="col" className="py-1 text-right font-medium">{t("stats.messages")}</th>
                                <th scope="col" className="py-1 text-right font-medium">{t("stats.gifts")}</th>
                                <th scope="col" className="py-1 text-right font-medium">{t("stats.diamonds")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {summary.topViewers.map((viewer) => (
                                <tr key={viewer.uniqueId} className="border-t border-border/50">
                                    <td className="max-w-0 truncate py-1 text-fg">
                                        {viewer.nickname} <span className="text-fg-subtle">@{viewer.uniqueId}</span>
                                    </td>
                                    <td className="py-1 text-right tabular-nums">{nf.format(viewer.messages)}</td>
                                    <td className="py-1 text-right tabular-nums">{nf.format(viewer.gifts)}</td>
                                    <td className="py-1 text-right tabular-nums">{nf.format(viewer.diamonds)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}

/** Post-live review (WS20-10): opens on its own when a live ends, or from the Live route. */
export function SummaryDialog() {
    const { t, i18n } = useTranslation();
    const state = useAppStore((s) => s.summary);
    const open = useAppStore((s) => s.openSummary);
    const close = useAppStore((s) => s.closeSummary);
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const selectId = useId();

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (state.open && !dialog.open) dialog.showModal();
        else if (!state.open && dialog.open) dialog.close();
    }, [state.open]);

    useEffect(
        () =>
            sidecarClient.onMessage((message) => {
                if (message.type !== "summaryExported") return;
                if (message.ok) toast.success(t("summary.exported"));
                else toast.error(t("summary.exportFailed", { error: message.error ?? "" }));
            }),
        [t],
    );

    const summary = state.current;
    const exportTitle = t("summary.export");

    return (
        <dialog
            ref={ref}
            aria-labelledby={titleId}
            onClose={close}
            className="surface m-auto w-[min(46rem,92vw)] max-h-[88vh] overflow-hidden rounded-[--radius-card] p-0 text-fg backdrop:bg-black/50"
        >
            <div className="flex max-h-[88vh] flex-col">
                <header className="flex items-start gap-3 border-b border-border/60 p-4">
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-sm font-semibold">
                            {t("summary.title")}
                        </h2>
                        {summary && (
                            <p className="text-xs text-fg-muted">
                                @{summary.session.username} · {new Date(summary.session.startedAt).toLocaleString(i18n.language)} ·{" "}
                                {formatDuration(summary.durationMs)}
                                {summary.session.endedAt === undefined && (
                                    <>
                                        {" "}
                                        <StatusPill tone="success" pulse>
                                            {t("connection.state.live")}
                                        </StatusPill>
                                    </>
                                )}
                            </p>
                        )}
                    </div>
                    <Button size="icon-sm" variant="ghost" aria-label={t("common.close")} title={t("common.close")} onClick={close}>
                        <X />
                    </Button>
                </header>

                <div className="flex flex-wrap items-end gap-2 border-b border-border/60 px-4 py-3">
                    {state.sessions.length > 0 && (
                        <div className="min-w-48 flex-1 space-y-1">
                            <label htmlFor={selectId} className="block text-[0.6875rem] text-fg-muted">
                                {t("summary.session")}
                            </label>
                            <select
                                id={selectId}
                                value={summary?.session.id ?? ""}
                                onChange={(event) => open(Number(event.target.value))}
                                className="no-drag h-8 w-full rounded-[--radius-chip] border border-border bg-panel-alt px-2 text-xs text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring/40"
                            >
                                {state.sessions.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {new Date(s.startedAt).toLocaleString(i18n.language)} · @{s.username}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    <Button size="sm" variant="soft" icon={<FileText />} disabled={!summary} onClick={() => summary && void exportSummary(summary, "csv", exportTitle)}>
                        {t("summary.exportCsv")}
                    </Button>
                    <Button size="sm" variant="soft" icon={<Download />} disabled={!summary} onClick={() => summary && void exportSummary(summary, "json", exportTitle)}>
                        {t("summary.exportJson")}
                    </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {state.loading && !summary ? (
                        <div className="grid place-items-center py-10">
                            <LoadingPulse label={t("common.loading")} />
                        </div>
                    ) : summary ? (
                        <SummaryBody summary={summary} />
                    ) : (
                        <EmptyState icon={<FileText />} title={t("summary.empty")} description={state.error ?? t("summary.emptyHint")} />
                    )}
                </div>
            </div>
        </dialog>
    );
}
