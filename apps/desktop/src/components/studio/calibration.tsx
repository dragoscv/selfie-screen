import type { VisionCalibration } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { CalibrationSample } from "../../lib/studio/controller.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";
import { computeCalibration, type CalibrationSet } from "./geometry.js";

type SampleKey = keyof CalibrationSet;

const STEPS: readonly { key: SampleKey; emoji: string }[] = [
    { key: "baseline", emoji: "😐" },
    { key: "leftClosed", emoji: "😉" },
    { key: "rightClosed", emoji: "😉" },
    { key: "smile", emoji: "😁" },
    { key: "mouthOpen", emoji: "😮" },
    { key: "browsUp", emoji: "🤨" },
    { key: "posture", emoji: "🧍" },
];

const COUNTDOWN_S = 3;
const SAMPLE_MS = 2000;

type Phase = { kind: "intro" } | { kind: "countdown"; n: number } | { kind: "sampling" } | { kind: "distance" } | { kind: "review"; result: VisionCalibration };

/** Calibration wizard: countdown + 2 s sample per expression, thresholds, distance reference, save. */
export function Calibration({ onClose }: { onClose: () => void }) {
    const { controller, vision, patchVision } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [index, setIndex] = useState(0);
    const [phase, setPhase] = useState<Phase>({ kind: "intro" });
    const [distance, setDistance] = useState(String(vision.calibration.referenceM || 1));
    const samples = useRef<Partial<CalibrationSet>>({});
    const dialog = useRef<HTMLDivElement>(null);
    const cancelled = useRef(false);
    const step = STEPS[index];

    useEffect(() => {
        dialog.current?.focus({ preventScroll: true });
        cancelled.current = false;
        return () => {
            cancelled.current = true;
        };
    }, []);

    const capture = async () => {
        if (!step) return;
        for (let n = COUNTDOWN_S; n > 0; n--) {
            setPhase({ kind: "countdown", n });
            await new Promise((r) => window.setTimeout(r, 1000));
            if (cancelled.current) return;
        }
        setPhase({ kind: "sampling" });
        let s: CalibrationSample;
        try {
            s = await controller.sampleCalibration(SAMPLE_MS);
        } catch (e) {
            toast.error(t("studio.calibration.failed", { error: String(e) }));
            setPhase({ kind: "intro" });
            return;
        }
        if (cancelled.current) return;
        if (!s.faceVisible) {
            toast.warning(t("studio.calibration.noFace"));
            setPhase({ kind: "intro" });
            return;
        }
        samples.current[step.key] = s;
        if (step.key === "posture") {
            setPhase({ kind: "distance" });
            return;
        }
        setIndex((i) => i + 1);
        setPhase({ kind: "intro" });
    };

    const review = () => {
        const set = samples.current;
        const metres = Number(distance.replace(",", "."));
        if (!Number.isFinite(metres) || metres < 0.3 || metres > 4) {
            toast.error(t("studio.calibration.distanceInvalid"));
            return;
        }
        if (!set.baseline || !set.leftClosed || !set.rightClosed || !set.smile || !set.mouthOpen || !set.browsUp || !set.posture) return;
        setPhase({
            kind: "review",
            result: computeCalibration(
                { baseline: set.baseline, leftClosed: set.leftClosed, rightClosed: set.rightClosed, smile: set.smile, mouthOpen: set.mouthOpen, browsUp: set.browsUp, posture: set.posture },
                metres,
                Date.now(),
            ),
        });
    };

    const restart = () => {
        samples.current = {};
        setIndex(0);
        setPhase({ kind: "intro" });
    };

    const save = (result: VisionCalibration) => {
        patchVision({ calibration: result });
        toast.success(t("studio.calibration.saved"));
        onClose();
    };

    const busy = phase.kind === "countdown" || phase.kind === "sampling";

    return (
        <div className="absolute inset-0 z-30 grid place-items-end justify-center bg-black/30 p-6 pb-28">
            <motion.div
                ref={dialog}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cal-title"
                onKeyDown={(e) => {
                    if (e.key === "Escape" && !busy) onClose();
                }}
                initial={reduced ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduced ? INSTANT : SPRING}
                className={`${GLASS} w-[28rem] max-w-full rounded-3xl p-5 outline-none`}
            >
                <div className="flex items-start justify-between">
                    <div>
                        <h2 id="cal-title" className="text-base font-semibold">
                            {t("studio.calibration.title")}
                        </h2>
                        <p className="text-[0.6875rem] text-white/70">{t("studio.calibration.progress", { n: Math.min(index + 1, STEPS.length), total: STEPS.length })}</p>
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 disabled:opacity-40 ${FOCUS_RING}`}>
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15" aria-hidden>
                    <motion.div className="h-full bg-sky-300" animate={{ width: `${((phase.kind === "review" ? STEPS.length : index) / STEPS.length) * 100}%` }} transition={reduced ? INSTANT : SPRING} />
                </div>

                {phase.kind === "review" ? (
                    <div className="mt-4 space-y-3">
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                            {(["blinkLeft", "blinkRight", "smile", "mouthOpen", "browsUp", "shoulderPx", "ipdPx", "neckRatio", "referenceM"] as const).map((k) => (
                                <div key={k} className="flex justify-between gap-2 border-b border-white/10 pb-1">
                                    <dt className="text-white/75">{t(`studio.calibration.fields.${k}`)}</dt>
                                    <dd className="font-semibold tabular-nums">{phase.result[k]}</dd>
                                </div>
                            ))}
                            <div className="col-span-2 flex justify-between gap-2">
                                <dt className="text-white/75">{t("studio.calibration.fields.swapEyes")}</dt>
                                <dd className="font-semibold">{phase.result.swapEyes ? t("studio.common.yes") : t("studio.common.no")}</dd>
                            </div>
                        </dl>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={restart} className={`flex items-center gap-1 rounded-xl px-3 py-2 text-xs hover:bg-white/15 ${FOCUS_RING}`}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {t("studio.calibration.redo")}
                            </button>
                            <button type="button" onClick={() => save(phase.result)} className={`flex items-center gap-1 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-300 ${FOCUS_RING}`}>
                                <Check className="size-3.5" aria-hidden />
                                {t("studio.calibration.save")}
                            </button>
                        </div>
                    </div>
                ) : step ? (
                    <div className="mt-4 flex items-center gap-4">
                        <div className="relative grid size-20 shrink-0 place-items-center rounded-2xl bg-white/10 text-5xl" aria-hidden>
                            {step.emoji}
                            <AnimatePresence>
                                {(phase.kind === "countdown" || phase.kind === "sampling") && (
                                    <motion.span
                                        key={phase.kind === "countdown" ? phase.n : "s"}
                                        initial={reduced ? false : { scale: 1.6, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={reduced ? INSTANT : SPRING}
                                        className="absolute inset-0 grid place-items-center rounded-2xl bg-sky-500/85 text-3xl font-bold text-white"
                                    >
                                        {phase.kind === "countdown" ? phase.n : "●"}
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </div>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold">{t(`studio.calibration.steps.${step.key}.title`)}</h3>
                            <p className="mt-1 text-sm leading-snug text-white/85">{t(`studio.calibration.steps.${step.key}.body`)}</p>
                            <p className="mt-1 text-[0.6875rem] text-sky-200" aria-live="assertive">
                                {phase.kind === "countdown" ? t("studio.calibration.countdown", { n: phase.n }) : phase.kind === "sampling" ? t("studio.calibration.hold") : ""}
                            </p>
                            {phase.kind === "distance" && (
                                <label className="mt-3 block text-xs text-white/85">
                                    {t("studio.calibration.distanceLabel")}
                                    <span className="mt-1 flex items-center gap-2">
                                        <input
                                            type="number"
                                            inputMode="decimal"
                                            min={0.3}
                                            max={4}
                                            step={0.05}
                                            value={distance}
                                            onChange={(e) => setDistance(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") review();
                                            }}
                                            className="w-24 rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none focus:border-sky-300"
                                        />
                                        m
                                    </span>
                                </label>
                            )}
                        </div>
                    </div>
                ) : null}

                {phase.kind !== "review" && (
                    <div className="mt-4 flex justify-end gap-2">
                        {phase.kind === "distance" ? (
                            <button type="button" onClick={review} className={`rounded-xl bg-sky-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-sky-300 ${FOCUS_RING}`}>
                                {t("studio.calibration.review")}
                            </button>
                        ) : (
                            <button type="button" disabled={busy} onClick={() => void capture()} className={`rounded-xl bg-sky-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-sky-300 disabled:opacity-50 ${FOCUS_RING}`}>
                                {busy ? t("studio.calibration.capturing") : t("studio.calibration.start")}
                            </button>
                        )}
                    </div>
                )}
            </motion.div>
        </div>
    );
}
