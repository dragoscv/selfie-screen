import { beautySchema, type BeautySettings } from "@tiksee/core";
import { SliderRow, SwitchRow } from "@tiksee/ui";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { lipColor } from "../../lib/studio/beauty-color.js";
import { FOCUS_RING, useStudio } from "./context.js";
import { Section } from "./controls-parts.js";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signedPct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
const DEFAULTS = beautySchema.parse({});

/** Natural one-tap looks; sliders then fine-tune them. */
const PRESETS: Readonly<Record<"natural" | "glam" | "fresh", Partial<BeautySettings>>> = {
    natural: { skin: { smooth: 0.45, even: 0.25, brighten: 0.1, blush: 0 }, eyes: { enlarge: 0, brighten: 0.15, darkCircles: 0.2 }, teeth: { whiten: 0.15 }, lips: { amount: 0, hue: 0.97 } },
    fresh: { skin: { smooth: 0.55, even: 0.35, brighten: 0.18, blush: 0.25 }, eyes: { enlarge: 0.12, brighten: 0.3, darkCircles: 0.4 }, teeth: { whiten: 0.35 }, lips: { amount: 0.2, hue: 0.98 } },
    glam: { skin: { smooth: 0.7, even: 0.5, brighten: 0.2, blush: 0.35 }, eyes: { enlarge: 0.22, brighten: 0.45, darkCircles: 0.55 }, teeth: { whiten: 0.5 }, lips: { amount: 0.5, hue: 0.95 } },
};

/**
 * Beauty on the owner's face (face landmarks -> region masks + gentle warps in the camera shader).
 * Every change applies live; the whole effect fades out when the face is lost.
 */
export function BeautyPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const b = studio.beauty;
    const set = (p: Partial<BeautySettings>) => patchStudio({ beauty: { ...b, ...p } });
    const skin = (p: Partial<BeautySettings["skin"]>) => set({ skin: { ...b.skin, ...p } });
    const eyes = (p: Partial<BeautySettings["eyes"]>) => set({ eyes: { ...b.eyes, ...p } });
    const lips = (p: Partial<BeautySettings["lips"]>) => set({ lips: { ...b.lips, ...p } });
    const shape = (p: Partial<BeautySettings["shape"]>) => set({ shape: { ...b.shape, ...p } });
    const off = !b.enabled;
    const [lr, lg, lb] = lipColor(b.lips.hue);

    return (
        <>
            <Section title={t("studio.beauty.title")}>
                <SwitchRow label={t("studio.beauty.enabled")} description={t("studio.beauty.enabledHint")} checked={b.enabled} onChange={(enabled) => set({ enabled })} />
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("studio.beauty.presets")}>
                    {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
                        <button
                            key={k}
                            type="button"
                            disabled={off}
                            onClick={() => set({ ...PRESETS[k] })}
                            className={`rounded-full bg-white/10 px-2.5 py-1 text-[0.6875rem] font-medium hover:bg-white/20 disabled:opacity-40 ${FOCUS_RING}`}
                        >
                            {t(`studio.beauty.preset.${k}`)}
                        </button>
                    ))}
                    <button
                        type="button"
                        disabled={off}
                        onClick={() => set({ ...DEFAULTS, enabled: true })}
                        className={`flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[0.6875rem] font-medium hover:bg-white/20 disabled:opacity-40 ${FOCUS_RING}`}
                    >
                        <RotateCcw className="size-3" aria-hidden />
                        {t("studio.beauty.reset")}
                    </button>
                </div>
            </Section>
            <Section title={t("studio.beauty.skin.title")}>
                <SliderRow label={t("studio.beauty.skin.smooth")} value={b.skin.smooth} min={0} max={1} step={0.05} format={pct} onCommit={(smooth) => skin({ smooth })} disabled={off} />
                <SliderRow label={t("studio.beauty.skin.even")} value={b.skin.even} min={0} max={1} step={0.05} format={pct} onCommit={(even) => skin({ even })} disabled={off} />
                <SliderRow label={t("studio.beauty.skin.brighten")} value={b.skin.brighten} min={0} max={1} step={0.05} format={pct} onCommit={(brighten) => skin({ brighten })} disabled={off} />
                <SliderRow label={t("studio.beauty.skin.blush")} value={b.skin.blush} min={0} max={1} step={0.05} format={pct} onCommit={(blush) => skin({ blush })} disabled={off} />
            </Section>
            <Section title={t("studio.beauty.eyes.title")}>
                <SliderRow label={t("studio.beauty.eyes.enlarge")} value={b.eyes.enlarge} min={0} max={1} step={0.05} format={pct} onCommit={(enlarge) => eyes({ enlarge })} disabled={off} />
                <SliderRow label={t("studio.beauty.eyes.brighten")} value={b.eyes.brighten} min={0} max={1} step={0.05} format={pct} onCommit={(brighten) => eyes({ brighten })} disabled={off} />
                <SliderRow label={t("studio.beauty.eyes.darkCircles")} value={b.eyes.darkCircles} min={0} max={1} step={0.05} format={pct} onCommit={(darkCircles) => eyes({ darkCircles })} disabled={off} />
            </Section>
            <Section title={t("studio.beauty.mouth.title")}>
                <SliderRow label={t("studio.beauty.mouth.teeth")} value={b.teeth.whiten} min={0} max={1} step={0.05} format={pct} onCommit={(whiten) => set({ teeth: { whiten } })} disabled={off} />
                <SliderRow label={t("studio.beauty.mouth.lips")} value={b.lips.amount} min={0} max={1} step={0.05} format={pct} onCommit={(amount) => lips({ amount })} disabled={off} />
                <div className="flex items-center gap-2">
                    <span aria-hidden className="size-4 shrink-0 rounded-full ring-1 ring-white/30" style={{ background: `rgb(${Math.round(lr * 255)} ${Math.round(lg * 255)} ${Math.round(lb * 255)})` }} />
                    <div className="min-w-0 flex-1">
                        <SliderRow label={t("studio.beauty.mouth.lipHue")} value={b.lips.hue} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 360)}°`} onCommit={(hue) => lips({ hue })} disabled={off || b.lips.amount === 0} />
                    </div>
                </div>
            </Section>
            <Section title={t("studio.beauty.shape.title")}>
                <SliderRow label={t("studio.beauty.shape.slim")} value={b.shape.slim} min={-1} max={1} step={0.05} format={signedPct} onCommit={(slim) => shape({ slim })} disabled={off} />
                <SliderRow label={t("studio.beauty.shape.jaw")} value={b.shape.jaw} min={-1} max={1} step={0.05} format={signedPct} onCommit={(jaw) => shape({ jaw })} disabled={off} />
                <SliderRow label={t("studio.beauty.shape.nose")} value={b.shape.nose} min={-1} max={1} step={0.05} format={signedPct} onCommit={(nose) => shape({ nose })} disabled={off} />
                <SliderRow label={t("studio.beauty.shape.chin")} value={b.shape.chin} min={-1} max={1} step={0.05} format={signedPct} onCommit={(chin) => shape({ chin })} disabled={off} />
                <p className="text-[0.6875rem] text-white/70">{t("studio.beauty.shape.hint")}</p>
            </Section>
        </>
    );
}
