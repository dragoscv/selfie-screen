import { CAPTION_LANGUAGES, CAPTION_STYLES, GUIDE_KINDS, PEAKING_COLORS, SCOPE_KINDS, type CaptionSettings, type StudioSettings } from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { FOCUS_RING, INSTANT, SPRING, useStudio } from "./context.js";
import { Section } from "./controls-parts.js";

/** Expands/collapses its children with a height + fade morph. */
function Reveal({ show, children }: { show: boolean; children: React.ReactNode }) {
    const reduced = useReducedMotion();
    return (
        <AnimatePresence initial={false}>
            {show && (
                <motion.div
                    initial={reduced ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={reduced ? INSTANT : SPRING}
                    className="overflow-hidden"
                >
                    <div className="space-y-3 border-l-2 border-sky-300/40 py-1 pl-3">{children}</div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

function LanguageSelect({ value, onChange }: { value: CaptionSettings["lang"]; onChange: (v: CaptionSettings["lang"]) => void }) {
    const { t, i18n } = useTranslation();
    const id = useId();
    const names = useMemo(() => {
        const dn = new Intl.DisplayNames([i18n.language], { type: "language" });
        return CAPTION_LANGUAGES.map((l) => ({ value: l, label: dn.of(l) ?? l })).sort((a, b) => a.label.localeCompare(b.label, i18n.language));
    }, [i18n.language]);
    return (
        <div className="space-y-1">
            <label htmlFor={id} className="block text-[0.8125rem] text-white/80">
                {t("studio.captions.lang")}
            </label>
            <select
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value as CaptionSettings["lang"])}
                className={`w-full rounded-xl border border-white/15 bg-neutral-900/80 px-2.5 py-1.5 text-xs text-white ${FOCUS_RING}`}
            >
                {names.map((n) => (
                    <option key={n.value} value={n.value}>
                        {n.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

/** Studio dock Monitor panel (lazy chunk): focus, exposure, composition and audio aids, clean feed. */
export function MonitorPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const m = studio.monitor;
    const cap = studio.captions;
    const set = (p: Partial<StudioSettings["monitor"]>) => patchStudio({ monitor: { ...m, ...p } });
    const setCap = (p: Partial<CaptionSettings>) => patchStudio({ captions: { ...cap, ...p } });
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
                <Reveal show={m.transcript}>
                    <SwitchRow label={t("studio.captions.output")} description={t("studio.captions.outputHint")} checked={cap.output} onChange={(output) => setCap({ output })} />
                    <SwitchRow label={t("studio.captions.translate")} description={t("studio.captions.translateHint")} checked={cap.translate} onChange={(translate) => setCap({ translate })} />
                    <Reveal show={cap.translate}>
                        <LanguageSelect value={cap.lang} onChange={(lang) => setCap({ lang })} />
                    </Reveal>
                    <ChipSelector label={t("studio.captions.style")} options={CAPTION_STYLES} value={cap.style} onSelect={(style) => setCap({ style })} display={(v) => t(`studio.captions.styles.${v}`)} />
                    <ChipSelector label={t("studio.captions.lines")} options={["1", "2", "3", "4", "5"] as const} value={String(cap.lines) as "1"} onSelect={(v) => setCap({ lines: Number(v) })} />
                    <SliderRow label={t("studio.captions.rows")} value={cap.rows} min={1} max={8} step={1} format={(v) => t("studio.captions.rowsValue", { count: Math.round(v) })} onCommit={(rows) => setCap({ rows: Math.round(rows) })} />
                    {cap.output && <SliderRow label={t("studio.captions.size")} value={cap.scale} min={0.5} max={2.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(scale) => setCap({ scale })} />}
                    {cap.output && <p className="text-[0.6875rem] text-white/70">{t("studio.captions.editHint")}</p>}
                </Reveal>
                <SwitchRow label={t("studio.controls.monitor.mic.label")} description={t("studio.controls.monitor.mic.hint")} checked={m.micPanel} onChange={(micPanel) => set({ micPanel })} />
            </Section>
            <Section title={t("studio.controls.monitor.output")}>
                <SwitchRow label={t("studio.controls.monitor.cleanFeed")} description={t("studio.controls.monitor.cleanFeedHint")} checked={m.cleanFeed} onChange={(cleanFeed) => set({ cleanFeed })} />
            </Section>
        </>
    );
}
