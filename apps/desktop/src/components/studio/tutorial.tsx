import type { SignalId } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronRight, SkipForward, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";

type Wait = { kind: "none" } | { kind: "armed" } | { kind: "signal"; signals: readonly SignalId[] } | { kind: "depth" };

interface Step {
    id: string;
    emoji: string;
    wait: Wait;
}

const STEPS: readonly Step[] = [
    { id: "welcome", emoji: "👋", wait: { kind: "none" } },
    { id: "arm", emoji: "✋", wait: { kind: "armed" } },
    { id: "thumb", emoji: "👍", wait: { kind: "signal", signals: ["thumb_up"] } },
    { id: "victory", emoji: "✌️", wait: { kind: "signal", signals: ["victory"] } },
    { id: "heart", emoji: "🫶", wait: { kind: "signal", signals: ["heart"] } },
    { id: "winkLeft", emoji: "😉", wait: { kind: "signal", signals: ["wink_left"] } },
    { id: "winkRight", emoji: "😉", wait: { kind: "signal", signals: ["wink_right"] } },
    { id: "smile", emoji: "😄", wait: { kind: "signal", signals: ["smile"] } },
    { id: "swipe", emoji: "👉", wait: { kind: "signal", signals: ["swipe_left", "swipe_right"] } },
    { id: "timeout", emoji: "⏸️", wait: { kind: "signal", signals: ["timeout"] } },
    { id: "depth", emoji: "🚶", wait: { kind: "depth" } },
    { id: "done", emoji: "🎉", wait: { kind: "none" } },
];

/** Moving this far (m) from where the step started counts as crossing the demo line. */
const DEPTH_CROSS_M = 0.35;
const SUCCESS_MS = 900;

/** Guided gesture tutorial: each step waits for its signal (or Skip). */
export function Tutorial({ onClose }: { onClose: () => void }) {
    const { controller, frames, patchVision } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [index, setIndex] = useState(0);
    const [success, setSuccess] = useState(false);
    const step = STEPS[index] ?? STEPS[0];
    const dialog = useRef<HTMLDivElement>(null);
    const last = index === STEPS.length - 1;

    const advance = () => {
        setSuccess(false);
        setIndex((i) => Math.min(STEPS.length - 1, i + 1));
    };
    const finish = () => {
        patchVision({ tutorialDone: true });
        onClose();
    };

    useEffect(() => {
        dialog.current?.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        if (!step || success) return;
        const wait = step.wait;
        if (wait.kind === "none") return;
        let timer = 0;
        const hit = () => {
            setSuccess(true);
            timer = window.setTimeout(() => {
                setSuccess(false);
                setIndex((i) => Math.min(STEPS.length - 1, i + 1));
            }, SUCCESS_MS);
        };
        if (wait.kind === "depth") {
            let start: number | undefined;
            const off = frames.subscribe(() => {
                const m = frames.get()?.ownerDistanceM;
                if (m === undefined) return;
                start ??= m;
                if (Math.abs(m - start) >= DEPTH_CROSS_M) {
                    off();
                    hit();
                }
            });
            return () => {
                off();
                window.clearTimeout(timer);
            };
        }
        const off = controller.onSignals((events, armed) => {
            const ok =
                wait.kind === "armed"
                    ? armed
                    : events.some((e) => e.phase !== "end" && (wait.signals as readonly string[]).includes(e.signal));
            if (ok) {
                off();
                hit();
            }
        });
        return () => {
            off();
            window.clearTimeout(timer);
        };
    }, [controller, frames, step, success]);

    if (!step) return null;
    const waiting = step.wait.kind !== "none";

    return (
        <div className="absolute inset-0 z-30 grid place-items-end justify-center bg-black/25 p-6 pb-28">
            <motion.div
                ref={dialog}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="tutorial-title"
                aria-describedby="tutorial-body"
                onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                }}
                initial={reduced ? false : { opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={reduced ? INSTANT : SPRING}
                className={`${GLASS} w-[26rem] max-w-full rounded-3xl p-5 outline-none`}
            >
                <div className="flex items-start justify-between">
                    <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-white/70">
                        {t("studio.tutorial.progress", { n: index + 1, total: STEPS.length })}
                    </p>
                    <button type="button" onClick={onClose} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}>
                        <X className="size-4" aria-hidden />
                    </button>
                </div>
                <AnimatePresence mode="wait">
                    <motion.div
                        key={step.id}
                        initial={reduced ? false : { opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 }}
                        transition={reduced ? INSTANT : SPRING}
                        className="mt-2 flex items-center gap-4"
                    >
                        <div className="relative grid size-20 shrink-0 place-items-center rounded-2xl bg-white/10 text-5xl" aria-hidden>
                            <motion.span animate={waiting && !success && !reduced ? { scale: [1, 1.08, 1] } : { scale: 1 }} transition={{ duration: 1.6, repeat: waiting && !success ? Infinity : 0 }}>
                                {step.emoji}
                            </motion.span>
                            <AnimatePresence>
                                {success && (
                                    <motion.span
                                        initial={reduced ? false : { scale: 0, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={reduced ? INSTANT : { type: "spring", bounce: 0.5, visualDuration: 0.35 }}
                                        className="absolute inset-0 grid place-items-center rounded-2xl bg-emerald-500/90"
                                    >
                                        <Check className="size-10 text-white" strokeWidth={3} />
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </div>
                        <div className="min-w-0">
                            <h2 id="tutorial-title" className="text-base font-semibold">
                                {t(`studio.tutorial.steps.${step.id}.title`)}
                            </h2>
                            <p id="tutorial-body" className="mt-1 text-sm leading-snug text-white/85">
                                {t(`studio.tutorial.steps.${step.id}.body`)}
                            </p>
                            <p className="mt-1.5 text-[0.6875rem] text-sky-200" aria-live="polite">
                                {success ? t("studio.tutorial.great") : waiting ? t("studio.tutorial.waiting") : ""}
                            </p>
                        </div>
                    </motion.div>
                </AnimatePresence>
                <div className="mt-4 flex items-center justify-between gap-3">
                    <ol className="flex gap-1.5" aria-hidden>
                        {STEPS.map((s, i) => (
                            <motion.li
                                key={s.id}
                                className={`h-1.5 rounded-full ${i < index ? "bg-emerald-400" : i === index ? "bg-sky-300" : "bg-white/25"}`}
                                animate={{ width: i === index ? 18 : 6 }}
                                transition={reduced ? INSTANT : SPRING}
                            />
                        ))}
                    </ol>
                    <div className="flex gap-2">
                        {waiting && !last && (
                            <button type="button" onClick={advance} className={`flex items-center gap-1 rounded-xl px-3 py-2 text-xs text-white/85 hover:bg-white/15 ${FOCUS_RING}`}>
                                <SkipForward className="size-3.5" aria-hidden />
                                {t("studio.tutorial.skip")}
                            </button>
                        )}
                        {!waiting && (
                            <button
                                type="button"
                                onClick={last ? finish : advance}
                                className={`flex items-center gap-1 rounded-xl bg-sky-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-sky-300 ${FOCUS_RING}`}
                            >
                                {last ? t("studio.tutorial.finish") : t("studio.tutorial.next")}
                                {!last && <ChevronRight className="size-3.5" aria-hidden />}
                            </button>
                        )}
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
