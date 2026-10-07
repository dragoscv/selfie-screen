import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ShieldCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { GLASS, INSTANT, SIGNAL_EMOJI, SPRING, useLingering, useSettledFrame, useStudio } from "./context.js";

const EMPTY: readonly never[] = [];
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;
const TOAST_MS = 3000;
const MAX_TOASTS = 4;

interface Fired {
    key: string;
    name: string;
    blocked?: string;
}

/** Hold-progress rings at each live gesture. */
function Rings() {
    const { frames, rect } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    // Gesture classification wobbles frame to frame; ring needs ~150 ms of the
    // same gesture to appear and survives 400 ms of dropouts (no flicker).
    const hints = useLingering(frames, (i) => i?.hints ?? EMPTY, (h) => `${h.signal}-${h.hand ?? "x"}`, 150, 400);
    if (rect.width <= 0) return null;
    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
            <AnimatePresence>
            {hints.map((h) => (
                <motion.div
                    key={`${h.signal}-${h.hand ?? "x"}`}
                    className="absolute flex flex-col items-center gap-1"
                    style={{ x: "-50%", y: "-50%" }}
                    initial={{ opacity: 0, scale: reduced ? 1 : 0.85, left: rect.left + h.at[0] * rect.width, top: rect.top + h.at[1] * rect.height }}
                    animate={{ opacity: 1, scale: 1, left: rect.left + h.at[0] * rect.width, top: rect.top + h.at[1] * rect.height }}
                    exit={{ opacity: 0, scale: reduced ? 1 : 0.9 }}
                    transition={reduced ? INSTANT : { type: "spring", bounce: 0.1, visualDuration: 0.2 }}
                >
                    <div className="relative grid size-14 place-items-center rounded-full bg-black/45 backdrop-blur-md">
                        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 56 56">
                            <circle cx={28} cy={28} r={RING_R} fill="none" stroke="rgb(255 255 255 / 0.2)" strokeWidth={4} />
                            <circle
                                cx={28}
                                cy={28}
                                r={RING_R}
                                fill="none"
                                stroke={h.progress >= 1 ? "rgb(52 211 153)" : "rgb(125 211 252)"}
                                strokeWidth={4}
                                strokeLinecap="round"
                                strokeDasharray={RING_C}
                                strokeDashoffset={RING_C * (1 - Math.min(1, Math.max(0, h.progress)))}
                                style={{ transition: "stroke-dashoffset 80ms linear" }}
                            />
                        </svg>
                        <span className="text-2xl">{SIGNAL_EMOJI[h.signal] ?? "✨"}</span>
                    </div>
                    <span className="rounded-full bg-black/70 px-2 py-0.5 text-[0.6875rem] font-medium text-white">
                        {t(`vision.signals.${h.signal}`, { defaultValue: h.signal })}
                    </span>
                </motion.div>
            ))}
            </AnimatePresence>
        </div>
    );
}

/** Glowing "ARMED" badge with the remaining arm window. */
function ArmedBadge() {
    const { frames, vision } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const armed = useSettledFrame(frames, (i) => i?.armed ?? false, false, 0, 400);
    const [left, setLeft] = useState(0);

    useEffect(() => {
        if (!armed) return;
        const until = Date.now() + vision.armWindowMs;
        const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
        const first = window.setTimeout(tick, 0);
        const id = window.setInterval(tick, 250);
        return () => {
            window.clearTimeout(first);
            window.clearInterval(id);
        };
    }, [armed, vision.armWindowMs]);

    return (
        <AnimatePresence>
            {armed && (
                <motion.div
                    role="status"
                    key="armed"
                    initial={reduced ? false : { opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduced ? INSTANT : SPRING}
                    className="flex items-center gap-2 rounded-full border border-emerald-300/70 bg-emerald-500/25 px-3 py-1.5 text-xs font-bold tracking-wide text-emerald-100 shadow-[0_0_24px_rgb(52_211_153/0.65)] backdrop-blur-xl"
                >
                    <ShieldCheck className="size-4" aria-hidden />
                    {t("studio.hud.armed", { s: left })}
                </motion.div>
            )}
        </AnimatePresence>
    );
}

/** Rule-fired pills, stacked bottom-left, auto-dismissed after 3 s. */
function RuleToasts() {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [items, setItems] = useState<Fired[]>([]);

    useEffect(() => {
        const timers = new Set<number>();
        const off = sidecarClient.onMessage((m) => {
            if (m.type !== "ruleFired") return;
            const item: Fired = {
                key: `${m.fired.ruleId}-${m.fired.at}`,
                name: m.fired.ruleName,
                ...(m.fired.blocked ? { blocked: m.fired.blocked } : {}),
            };
            setItems((prev) => [...prev.filter((p) => p.key !== item.key), item].slice(-MAX_TOASTS));
            const id = window.setTimeout(() => {
                timers.delete(id);
                setItems((prev) => prev.filter((p) => p.key !== item.key));
            }, TOAST_MS);
            timers.add(id);
        });
        return () => {
            off();
            for (const id of timers) window.clearTimeout(id);
        };
    }, []);

    return (
        <ol className="flex flex-col-reverse gap-2" aria-live="polite" aria-label={t("studio.hud.rules")}>
            <AnimatePresence initial={false}>
                {items.map((item) => (
                    <motion.li
                        key={item.key}
                        layout={!reduced}
                        initial={reduced ? false : { opacity: 0, x: -24, scale: 0.9 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 }}
                        transition={reduced ? INSTANT : SPRING}
                        className={`${GLASS} flex items-center gap-2 rounded-full px-3 py-1.5 text-xs`}
                    >
                        <Zap className={`size-3.5 ${item.blocked ? "text-white/50" : "text-amber-300"}`} aria-hidden />
                        <span className="font-semibold">{item.name}</span>
                        {item.blocked && <span className="text-white/70">· {t("studio.hud.blocked", { reason: item.blocked })}</span>}
                    </motion.li>
                ))}
            </AnimatePresence>
        </ol>
    );
}

export function GestureHud() {
    const { vision, studio } = useStudio();
    return (
        <>
            {vision.showGestureHud && <Rings />}
            <div className="pointer-events-none absolute inset-x-3 top-[max(12%,6rem)] flex justify-center">
                <ArmedBadge />
            </div>
            {/* Above the caption lane (Captions, up to ~3 lines over the dock) when captions are on. */}
            <div className={`pointer-events-none absolute left-3 max-w-[calc(100%-1.5rem)] ${studio.monitor.transcript ? "bottom-[max(24%,13rem)]" : "bottom-[max(14%,7.5rem)]"}`}>
                <RuleToasts />
            </div>
        </>
    );
}
