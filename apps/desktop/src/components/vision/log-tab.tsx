import { SIGNAL_IDS, type SignalId } from "@tiksee/core";
import { Button, Card, EmptyState, SliderRow, SwitchRow } from "@tiksee/ui";
import { Download, History, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { SIGNAL_EMOJI } from "../../lib/vision/catalog.js";
import { LOG_WINDOWS, formatMs, logToCsv, statsFrom, subjectLabel, windowStart, type LogWindow } from "../../lib/vision/log.js";
import { useVisionSettings } from "../../lib/vision/use-vision.js";
import { useAppStore } from "../../store/app-store.js";
import { ConfirmDialog, MiniSelect } from "./fields.js";

/** Shown rows are capped; the stats come from the sidecar over the whole window. */
const LIMIT = 1000;

function downloadCsv(csv: string, name: string): void {
    // WebView2 honours <a download> for Blob URLs, so no fs plugin is needed in the main window.
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function LogTab() {
    const { t, i18n } = useTranslation();
    const [vision, patch] = useVisionSettings();
    const log = useAppStore((s) => s.visionLog);
    const connected = useAppStore((s) => s.sidecarConnected);
    const [win, setWin] = useState<LogWindow>("1h");
    const [signal, setSignal] = useState<SignalId | "">("");
    const [person, setPerson] = useState("");
    const [confirmClear, setConfirmClear] = useState(false);

    const query = useCallback(() => {
        sidecarClient.send({
            type: "visionLogQuery",
            sinceMs: windowStart(win, Date.now()),
            limit: LIMIT,
            ...(signal ? { signal } : {}),
        });
    }, [win, signal]);

    useEffect(() => {
        if (connected) query();
    }, [connected, query]);

    const entries = useMemo(() => log?.entries ?? [], [log]);
    const people = useMemo(() => [...new Set(entries.map(subjectLabel))].sort(), [entries]);
    const filtered = useMemo(() => (person ? entries.filter((e) => subjectLabel(e) === person) : entries), [entries, person]);
    const stats = useMemo(() => (person ? statsFrom(filtered) : (log?.stats ?? [])), [person, filtered, log]);
    const nf = new Intl.NumberFormat(i18n.language);
    const who = (label: string) => (label === "owner" ? t("vision.log.you") : label === "person" ? t("vision.kinds.person") : label === "dog" ? t("vision.kinds.dog") : label);

    return (
        <div className="flex flex-col gap-3">
            <Card
                title={t("vision.log.title")}
                subtitle={t("vision.log.hint")}
                icon={<History />}
                actions={
                    <>
                        <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={query} disabled={!connected}>
                            {t("vision.log.refresh")}
                        </Button>
                        <Button
                            size="sm"
                            variant="soft"
                            icon={<Download />}
                            disabled={filtered.length === 0}
                            onClick={() => {
                                downloadCsv(logToCsv(filtered), `tiksee-vision-${new Date().toISOString().slice(0, 10)}.csv`);
                                toast.success(t("vision.log.exported", { count: filtered.length }));
                            }}
                        >
                            {t("vision.log.export")}
                        </Button>
                        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setConfirmClear(true)}>
                            {t("vision.log.clear")}
                        </Button>
                    </>
                }
            >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <MiniSelect label={t("vision.log.window")} value={win} options={LOG_WINDOWS.map((w) => ({ value: w, label: t(`vision.log.windows.${w}`) }))} onChange={(v) => setWin(v as LogWindow)} />
                    <MiniSelect
                        label={t("vision.log.signal")}
                        value={signal}
                        options={[{ value: "", label: t("vision.log.allSignals") }, ...SIGNAL_IDS.map((s) => ({ value: s, label: `${SIGNAL_EMOJI[s]} ${t(`vision.signals.${s}`)}` }))]}
                        onChange={(v) => setSignal(v as SignalId | "")}
                    />
                    <MiniSelect
                        label={t("vision.log.person")}
                        value={person}
                        options={[{ value: "", label: t("vision.log.everyone") }, ...people.map((p) => ({ value: p, label: who(p) }))]}
                        onChange={setPerson}
                    />
                </div>
            </Card>

            <Card title={t("vision.log.settings")} icon={<History />}>
                <SwitchRow label={t("vision.log.enabled")} description={t("vision.log.enabledHint")} checked={vision.logEnabled} onChange={(logEnabled) => patch({ logEnabled })} />
                <SliderRow
                    label={t("vision.log.retention")}
                    value={vision.logRetentionDays}
                    min={1}
                    max={365}
                    step={1}
                    format={(v) => t("common.days", { count: Math.round(v) })}
                    onCommit={(v) => patch({ logRetentionDays: Math.round(v) })}
                />
            </Card>

            {filtered.length === 0 ? (
                <EmptyState icon={<History />} title={t("vision.log.empty")} description={vision.logEnabled ? t("vision.log.emptyHint") : t("vision.log.disabledHint")} />
            ) : (
                <>
                    <section className="surface overflow-x-auto rounded-card p-3" aria-labelledby="vision-log-stats">
                        <h3 id="vision-log-stats" className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                            {t("vision.log.stats")}
                        </h3>
                        <table className="w-full text-left text-xs">
                            <thead className="text-[0.6875rem] text-fg-muted">
                                <tr>
                                    <th scope="col" className="py-1 pr-2 font-medium">{t("vision.log.signal")}</th>
                                    <th scope="col" className="py-1 pr-2 text-right font-medium">{t("vision.log.count")}</th>
                                    <th scope="col" className="py-1 pr-2 text-right font-medium">{t("vision.log.total")}</th>
                                    <th scope="col" className="py-1 text-right font-medium">{t("vision.log.longest")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.map((s) => (
                                    <tr key={s.signal} className="border-t border-border/50">
                                        <th scope="row" className="py-1 pr-2 font-normal text-fg">
                                            <span aria-hidden>{SIGNAL_EMOJI[s.signal]}</span> {t(`vision.signals.${s.signal}`)}
                                        </th>
                                        <td className="py-1 pr-2 text-right tabular-nums">{nf.format(s.count)}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums">{formatMs(s.totalMs)}</td>
                                        <td className="py-1 text-right tabular-nums">{formatMs(s.longestMs)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>

                    <section className="surface rounded-card p-3" aria-labelledby="vision-log-timeline">
                        <h3 id="vision-log-timeline" className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                            {t("vision.log.timeline", { count: filtered.length })}
                        </h3>
                        <ol className="flex max-h-[28rem] flex-col overflow-y-auto">
                            {filtered.map((e) => (
                                <li key={e.id} className="flex items-center gap-2 border-t border-border/40 py-1 text-xs first:border-t-0">
                                    <time className="w-20 shrink-0 tabular-nums text-fg-subtle" dateTime={new Date(e.startedAt).toISOString()}>
                                        {new Date(e.startedAt).toLocaleTimeString(i18n.language)}
                                    </time>
                                    <span aria-hidden>{SIGNAL_EMOJI[e.signal]}</span>
                                    <span className="min-w-0 flex-1 truncate text-fg">{t(`vision.signals.${e.signal}`)}</span>
                                    <span className="w-24 shrink-0 truncate text-fg-muted">{who(subjectLabel(e))}</span>
                                    <span className="w-16 shrink-0 text-right tabular-nums text-fg">{e.durationMs > 0 ? formatMs(e.durationMs) : "—"}</span>
                                </li>
                            ))}
                        </ol>
                    </section>
                </>
            )}

            <ConfirmDialog
                open={confirmClear}
                title={t("vision.log.clearTitle")}
                body={t("vision.log.clearBody")}
                confirmLabel={t("vision.log.clear")}
                danger
                onClose={() => setConfirmClear(false)}
                onConfirm={() => {
                    sidecarClient.send({ type: "visionLogClear" });
                    window.setTimeout(query, 300);
                    toast.success(t("vision.log.cleared"));
                }}
            />
        </div>
    );
}
