import { DEPTH_MODES } from "@tiksee/core";
import { Button, Card, ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { emitTo } from "@tauri-apps/api/event";
import { Crosshair, GraduationCap, HeartPulse, Ruler, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useOpenStudio, useVisionSettings } from "../../lib/vision/use-vision.js";

export function CalibrationTab() {
    const { t, i18n } = useTranslation();
    const [vision, patch] = useVisionSettings();
    const openStudio = useOpenStudio();
    const c = vision.calibration;
    const coach = vision.coach;
    const pct = (v: number) => `${Math.round(v * 100)}%`;

    const launch = async (mode: "tutorial" | "calibrate") => {
        try {
            await openStudio();
            await emitTo("studio", "studio://tutorial", { mode });
            toast(t(mode === "tutorial" ? "vision.calibration.tutorialSent" : "vision.calibration.calibrateSent"));
        } catch {
            toast.error(t("common.error"));
        }
    };

    const values: Array<[string, string]> = [
        ["blinkLeft", pct(c.blinkLeft)],
        ["blinkRight", pct(c.blinkRight)],
        ["smile", pct(c.smile)],
        ["mouthOpen", pct(c.mouthOpen)],
        ["browsUp", pct(c.browsUp)],
        ["shoulderPx", `${Math.round(c.shoulderPx)} px`],
        ["ipdPx", `${Math.round(c.ipdPx)} px`],
        ["referenceM", `${c.referenceM.toFixed(2)} m`],
        ["neckRatio", c.neckRatio.toFixed(2)],
        ["swapEyes", t(c.swapEyes ? "common.on" : "common.off")],
    ];

    return (
        <div className="flex flex-col gap-3">
            <Card
                title={t("vision.calibration.title")}
                subtitle={
                    c.calibratedAt > 0
                        ? t("vision.calibration.calibratedAt", { date: new Date(c.calibratedAt).toLocaleString(i18n.language) })
                        : t("vision.calibration.never")
                }
                icon={<Crosshair />}
                actions={
                    <>
                        <Button size="sm" variant="soft" icon={<GraduationCap />} onClick={() => void launch("tutorial")}>
                            {t("vision.calibration.tutorial")}
                        </Button>
                        <Button size="sm" icon={<Crosshair />} onClick={() => void launch("calibrate")}>
                            {t("vision.calibration.calibrate")}
                        </Button>
                    </>
                }
            >
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {values.map(([key, value]) => (
                        <div key={key} className="rounded-chip bg-panel-alt px-2.5 py-1.5">
                            <dt className="text-[0.625rem] uppercase tracking-wide text-fg-muted">{t(`vision.calibration.values.${key}`)}</dt>
                            <dd className="text-sm font-semibold tabular-nums text-fg">{value}</dd>
                        </div>
                    ))}
                </dl>
                <SwitchRow label={t("vision.calibration.tutorialDone")} checked={vision.tutorialDone} onChange={(tutorialDone) => patch({ tutorialDone })} />
            </Card>

            <Card title={t("vision.calibration.trackingTitle")} icon={<SlidersHorizontal />}>
                <SwitchRow label={t("vision.calibration.enabled")} description={t("vision.calibration.enabledHint")} checked={vision.enabled} onChange={(enabled) => patch({ enabled })} />
                <SliderRow label={t("vision.calibration.maxPeople")} value={vision.maxPeople} min={1} max={4} step={1} format={(v) => String(Math.round(v))} onCommit={(v) => patch({ maxPeople: Math.round(v) })} />
                <SliderRow
                    label={t("vision.calibration.armHold")}
                    value={vision.armHoldMs}
                    min={300}
                    max={3000}
                    step={100}
                    format={(v) => `${(v / 1000).toFixed(1)} s`}
                    onCommit={(v) => patch({ armHoldMs: Math.round(v) })}
                />
                <SliderRow
                    label={t("vision.calibration.armWindow")}
                    value={vision.armWindowMs}
                    min={1000}
                    max={30_000}
                    step={500}
                    format={(v) => `${(v / 1000).toFixed(1)} s`}
                    onCommit={(v) => patch({ armWindowMs: Math.round(v) })}
                />
                <p className="text-[0.6875rem] text-fg-muted">{t("vision.calibration.armHint")}</p>
                <SwitchRow label={t("vision.calibration.hud")} description={t("vision.calibration.hudHint")} checked={vision.showGestureHud} onChange={(showGestureHud) => patch({ showGestureHud })} />
            </Card>

            <Card title={t("vision.calibration.depthTitle")} subtitle={t("vision.calibration.depthHint")} icon={<Ruler />}>
                <ChipSelector
                    label={t("vision.calibration.depth")}
                    options={DEPTH_MODES}
                    value={vision.depth}
                    onSelect={(depth) => patch({ depth })}
                    display={(d) => t(`vision.calibration.depthModes.${d}`)}
                />
                {vision.depth === "model" && <p className="text-[0.6875rem] text-fg-muted">{t("vision.calibration.depthModelNote")}</p>}
            </Card>

            <Card title={t("vision.calibration.coachTitle")} subtitle={t("vision.calibration.coachHint")} icon={<HeartPulse />} tint="var(--kind-follow)">
                {(["eyeContact", "posture", "exposure", "safeZones", "energy"] as const).map((key) => (
                    <SwitchRow
                        key={key}
                        label={t(`vision.calibration.coach.${key}`)}
                        checked={coach[key]}
                        onChange={(v) => patch({ coach: { ...coach, [key]: v } })}
                        tint="var(--kind-follow)"
                    />
                ))}
                <SliderRow
                    label={t("vision.calibration.coach.hydration")}
                    value={coach.hydrationMin}
                    min={0}
                    max={240}
                    step={5}
                    format={(v) => (v < 1 ? t("common.off") : t("common.minutes", { count: Math.round(v) }))}
                    onCommit={(v) => patch({ coach: { ...coach, hydrationMin: Math.round(v) } })}
                    tint="var(--kind-follow)"
                />
            </Card>
        </div>
    );
}
