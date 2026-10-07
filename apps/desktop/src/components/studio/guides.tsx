import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { GLASS, INSTANT, SPRING, useFrame, useSettledFrame, useStudio } from "./context.js";
import { LANDSCAPE_TITLE_SAFE, PORTRAIT_SAFE_ZONES, guardianZone, guideLines, ownerFaceOf } from "./geometry.js";

/** Framing guides, horizon level and TikTok LIVE safe zones, scaled to the displayed image. */
export function Guides() {
    const { studio, vision, frames, rect } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const m = studio.monitor;
    const portrait = studio.orientation === "portrait";
    const guard = vision.coach.safeZones && m.safeZones;
    const horizon = useFrame(frames, (i) => (i ? Math.round(i.horizonDeg * 2) / 2 : 0));
    // Settled: the warning appears after 600 ms in a zone and leaves after 1 s out of it.
    const guardian = useSettledFrame(frames, (i) => (guard && i ? guardianZone(ownerFaceOf(i.faces), studio.orientation) : null), null, 600, 1000);
    const lines = guideLines(m.guides);
    const tilted = useSettledFrame(frames, (i) => (i ? Math.abs(i.horizonDeg) > 2.5 : false), false, 500, 900);
    const showHorizon = m.horizon && tilted;
    const pinch = useFrame(frames, (i) => (i?.pinchZoom ? `${i.pinchZoom.target.toFixed(1)}|${i.pinchZoom.optical ? 1 : 0}|${i.pinchZoom.digital.toFixed(1)}` : ""));
    if (rect.width <= 0) return null;
    const [pz, pzLens, pzCrop] = pinch.split("|");

    return (
        <div
            aria-hidden={guardian === null}
            className="pointer-events-none absolute"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
            <svg className="absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                {m.safeZones &&
                    (portrait ? (
                        PORTRAIT_SAFE_ZONES.map((z, i) => (
                            <rect
                                key={`${z.id}${i}`}
                                x={z.x}
                                y={z.y}
                                width={z.w}
                                height={z.h}
                                fill={guardian === z.id ? "rgb(251 113 133 / 0.28)" : z.id === "crop" ? "rgb(0 0 0 / 0.14)" : "rgb(0 0 0 / 0.28)"}
                                stroke={guardian === z.id ? "rgb(251 113 133 / 0.9)" : "rgb(255 255 255 / 0.25)"}
                                strokeDasharray="0.01 0.008"
                                vectorEffect="non-scaling-stroke"
                                strokeWidth={1}
                            />
                        ))
                    ) : (
                        <rect
                            x={LANDSCAPE_TITLE_SAFE.x}
                            y={LANDSCAPE_TITLE_SAFE.y}
                            width={LANDSCAPE_TITLE_SAFE.w}
                            height={LANDSCAPE_TITLE_SAFE.h}
                            fill="none"
                            stroke="rgb(255 255 255 / 0.35)"
                            strokeDasharray="6 6"
                            vectorEffect="non-scaling-stroke"
                            strokeWidth={1}
                        />
                    ))}
                {lines.xs.map((x) => (
                    <line key={`x${x}`} x1={x} x2={x} y1={0} y2={1} stroke="rgb(255 255 255 / 0.4)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                {lines.ys.map((y) => (
                    <line key={`y${y}`} x1={0} x2={1} y1={y} y2={y} stroke="rgb(255 255 255 / 0.4)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                {m.guides === "center" && (
                    <circle cx={0.5} cy={0.5} r={0.012} fill="none" stroke="rgb(255 255 255 / 0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                )}
            </svg>

            {showHorizon && (
                <div className="absolute inset-x-[12%] top-1/2 flex items-center justify-center">
                    <div className="absolute inset-x-0 h-px bg-white/35" />
                    <motion.div
                        className="absolute inset-x-0 h-0.5 rounded-full bg-amber-300 shadow-[0_0_8px_rgb(252_211_77/0.8)]"
                        animate={{ rotate: horizon }}
                        transition={reduced ? INSTANT : SPRING}
                    />
                    <span className={`${GLASS} relative mt-8 rounded-full px-2 py-0.5 text-[0.6875rem] tabular-nums`}>
                        {t("studio.guides.horizon", { deg: horizon.toFixed(1) })}
                    </span>
                </div>
            )}

            <AnimatePresence>
                {pinch !== "" && (
                    <motion.div
                        key="pinch-zoom"
                        role="status"
                        initial={reduced ? false : { opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={reduced ? INSTANT : SPRING}
                        className={`${GLASS} absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums`}
                    >
                        <span>{t("studio.controls.zoom.pinch.readout", { zoom: pz })}</span>
                        {pzLens === "1" && <span className="rounded-full bg-sky-400/25 px-2 text-[0.6875rem] text-sky-100">{t("studio.controls.zoom.pinch.lens")}</span>}
                        {Number(pzCrop) > 1.01 && <span className="rounded-full bg-amber-300/25 px-2 text-[0.6875rem] text-amber-100">{t("studio.controls.zoom.pinch.crop", { zoom: pzCrop })}</span>}
                    </motion.div>
                )}
                {guardian && (
                    <motion.div
                        key="guardian"
                        role="status"
                        initial={reduced ? false : { opacity: 0, y: 8, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.95 }}
                        transition={reduced ? INSTANT : SPRING}
                        className={`${GLASS} absolute left-1/2 top-[max(14%,7rem)] flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-2xl border-rose-300/60 px-3 py-1.5 text-xs font-medium`}
                    >
                        <TriangleAlert className="size-4 shrink-0 text-rose-300" aria-hidden />
                        <span className="min-w-0">{t(`studio.guides.guardian.${guardian}`)}</span>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
