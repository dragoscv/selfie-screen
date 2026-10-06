import { MOMENTARY_SIGNALS, SIGNAL_FAMILIES, type SignalId } from "@tiksee/core";
import { Card, StatusPill, cn } from "@tiksee/ui";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SIGNAL_EMOJI, rulesBySignal, signalsByFamily } from "../../lib/vision/catalog.js";
import { useVisionSettings } from "../../lib/vision/use-vision.js";
import { useAppStore } from "../../store/app-store.js";

/** A snapshot older than this is treated as "studio not running". */
const STALE_MS = 5000;

export function SignalsTab() {
    const { t } = useTranslation();
    const [vision, patch] = useVisionSettings();
    const snapshot = useAppStore((s) => s.visionSnapshot);
    const byFamily = useMemo(() => signalsByFamily(), []);
    const usage = useMemo(() => rulesBySignal(vision.rules), [vision.rules]);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 2000);
        return () => window.clearInterval(id);
    }, []);

    const live = snapshot !== null && now - snapshot.at < STALE_MS;
    const active = useMemo(() => {
        const set = new Set<SignalId>();
        if (live) for (const s of snapshot?.subjects ?? []) for (const a of s.active) set.add(a);
        return set;
    }, [snapshot, live]);

    return (
        <div className="flex flex-col gap-3">
            <Card
                title={t("vision.signalsTab.title")}
                subtitle={t("vision.signalsTab.hint")}
                icon={<Activity />}
                actions={
                    <StatusPill tone={live ? "success" : "neutral"} pulse={live}>
                        {live && snapshot
                            ? t("vision.signalsTab.live", { count: snapshot.subjects.length })
                            : t("vision.signalsTab.noStudio")}
                    </StatusPill>
                }
            >
                {snapshot && (
                    <p className="text-[0.6875rem] text-fg-muted">
                        {t("vision.signalsTab.perf", {
                            render: Math.round(snapshot.perf.renderFps),
                            camera: Math.round(snapshot.perf.cameraFps),
                            vcam: Math.round(snapshot.perf.vcamFps),
                        })}
                    </p>
                )}
            </Card>

            {SIGNAL_FAMILIES.map((family) => {
                const enabled = vision.families[family] ?? true;
                const headingId = `family-${family}`;
                return (
                    <section key={family} aria-labelledby={headingId} className={cn("surface rounded-card p-3", !enabled && "opacity-70")}>
                        <div className="mb-2 flex items-center gap-2">
                            <h3 id={headingId} className="flex-1 text-sm font-semibold text-fg">
                                {t(`vision.families.${family}`)}
                            </h3>
                            <label className="no-drag inline-flex min-h-9 items-center gap-2 text-xs text-fg">
                                <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) => patch({ families: { ...vision.families, [family]: e.target.checked } })}
                                    className="size-4 accent-[var(--accent)]"
                                />
                                {t("vision.signalsTab.detect")}
                            </label>
                        </div>
                        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                            {byFamily[family].map((id) => {
                                const on = enabled && active.has(id);
                                const rules = usage.get(id) ?? [];
                                return (
                                    <li
                                        key={id}
                                        className={cn(
                                            "flex items-start gap-2 rounded-chip border px-2 py-1.5 transition-colors duration-(--dur-fast)",
                                            on ? "border-accent bg-accent-subtle" : "border-border/60 bg-panel-alt",
                                        )}
                                    >
                                        <span aria-hidden className="text-base leading-none">
                                            {SIGNAL_EMOJI[id]}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="flex items-center gap-1.5 text-xs text-fg">
                                                <span className="truncate">{t(`vision.signals.${id}`)}</span>
                                                {on && <span className="text-[0.625rem] font-bold uppercase text-accent">{t("vision.signalsTab.activeNow")}</span>}
                                                {MOMENTARY_SIGNALS.has(id) && (
                                                    <span className="text-[0.625rem] text-fg-subtle" title={t("vision.signalsTab.momentaryHint")}>
                                                        {t("vision.signalsTab.momentary")}
                                                    </span>
                                                )}
                                            </p>
                                            <p className="truncate text-[0.625rem] text-fg-muted">
                                                {rules.length === 0 ? t("vision.signalsTab.unused") : rules.map((r) => r.name).join(", ")}
                                            </p>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
            <p className="sr-only" aria-live="polite">
                {[...active].map((id) => t(`vision.signals.${id}`)).join(", ")}
            </p>
        </div>
    );
}
