import { GUIDE_KINDS, PEAKING_COLORS, SCOPE_KINDS, type StudioSettings } from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { useTranslation } from "react-i18next";

import { useStudio } from "./context.js";
import { Section } from "./controls-parts.js";

/** Studio dock Monitor panel (lazy chunk): focus, exposure, composition and audio aids, clean feed. */
export function MonitorPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const m = studio.monitor;
    const set = (p: Partial<StudioSettings["monitor"]>) => patchStudio({ monitor: { ...m, ...p } });
    return (
        <>
            <Section title={t("studio.controls.monitor.focusAids")}>
                <SwitchRow label={t("studio.controls.monitor.peaking")} checked={m.peaking} onChange={(peaking) => set({ peaking })} />
                {m.peaking && (
                    <>
                        <ChipSelector options={PEAKING_COLORS} value={m.peakingColor} onSelect={(peakingColor) => set({ peakingColor })} display={(v) => t(`studio.controls.monitor.colors.${v}`)} label={t("studio.controls.monitor.peakingColor")} />
                        <SliderRow label={t("studio.controls.monitor.peakingThreshold")} value={m.peakingThreshold} min={0.03} max={0.5} step={0.01} format={(v) => v.toFixed(2)} onCommit={(peakingThreshold) => set({ peakingThreshold })} />
                    </>
                )}
                <SwitchRow label={t("studio.controls.monitor.afBox")} checked={m.afBox} onChange={(afBox) => set({ afBox })} />
                <ChipSelector label={t("studio.controls.monitor.loupeZoom")} options={["2", "4"] as const} value={String(m.loupeZoom) as "2" | "4"} onSelect={(v) => set({ loupeZoom: v === "4" ? 4 : 2 })} display={(v) => `${v}×`} />
            </Section>
            <Section title={t("studio.controls.monitor.exposureAids")}>
                <SwitchRow label={t("studio.controls.monitor.zebra")} checked={m.zebra} onChange={(zebra) => set({ zebra })} />
                {m.zebra && <SliderRow label={t("studio.controls.monitor.zebraLevel")} value={m.zebraLevel} min={50} max={100} step={1} format={(v) => `${v} IRE`} onCommit={(zebraLevel) => set({ zebraLevel: Math.round(zebraLevel) })} />}
                <SwitchRow label={t("studio.controls.monitor.falseColor")} checked={m.falseColor} onChange={(falseColor) => set({ falseColor })} />
                <SwitchRow label={t("studio.controls.monitor.clipping")} checked={m.clipping} onChange={(clipping) => set({ clipping })} />
                <ChipSelector label={t("studio.controls.monitor.scope")} options={SCOPE_KINDS} value={m.scope} onSelect={(scope) => set({ scope })} display={(v) => t(`studio.scopes.kind.${v}`)} />
            </Section>
            <Section title={t("studio.controls.monitor.composition")}>
                <ChipSelector label={t("studio.controls.monitor.guides")} options={GUIDE_KINDS} value={m.guides} onSelect={(guides) => set({ guides })} display={(v) => t(`studio.controls.monitor.guideKinds.${v}`)} />
                <SwitchRow label={t("studio.controls.monitor.safeZones")} checked={m.safeZones} onChange={(safeZones) => set({ safeZones })} />
                <SwitchRow label={t("studio.controls.monitor.horizon")} checked={m.horizon} onChange={(horizon) => set({ horizon })} />
                <SwitchRow label={t("studio.controls.monitor.debug3d.label")} description={t("studio.controls.monitor.debug3d.hint")} checked={m.debug3d} onChange={(debug3d) => set({ debug3d })} />
            </Section>
            <Section title={t("studio.controls.monitor.audioAids")}>
                <SwitchRow label={t("studio.controls.monitor.transcript.label")} description={t("studio.controls.monitor.transcript.hint")} checked={m.transcript} onChange={(transcript) => set({ transcript })} />
                <SwitchRow label={t("studio.controls.monitor.mic.label")} description={t("studio.controls.monitor.mic.hint")} checked={m.micPanel} onChange={(micPanel) => set({ micPanel })} />
            </Section>
            <Section title={t("studio.controls.monitor.output")}>
                <SwitchRow label={t("studio.controls.monitor.cleanFeed")} description={t("studio.controls.monitor.cleanFeedHint")} checked={m.cleanFeed} onChange={(cleanFeed) => set({ cleanFeed })} />
            </Section>
        </>
    );
}
