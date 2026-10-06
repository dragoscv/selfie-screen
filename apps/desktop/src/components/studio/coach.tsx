import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Activity, CupSoda, Eye, PersonStanding, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FOCUS_RING, GLASS, INSTANT, SPRING, useSettledFrame, useStudio } from "./context.js";

type NudgeId = "eyeContact" | "posture" | "hydration";

const LOOK_AWAY_MS = 5000;
const SLOUCH_MS = 3000;
/** The same nudge never repeats faster than this. */
const NUDGE_COOLDOWN_MS = 90_000;
const NUDGE_SHOW_MS = 6000;

const ICONS = { eyeContact: Eye, posture: PersonStanding, hydration: CupSoda } as const;

/** Owner's active signals as a stable string key ("look_away|slouch"). */
function ownerActive(info: ReturnType<ReturnType<typeof useStudio>["frames"]["get"]>): string {
    const owner = info?.snapshot.subjects.find((s) => s.owner) ?? info?.snapshot.subjects[0];
    return owner ? owner.active.filter((a) => a === "look_away" || a === "slouch").join("|") : "";
}

/** Owner energy rounded to 5 %, or -1 when nobody is measured. */
function ownerEnergy(info: ReturnType<ReturnType<typeof useStudio>["frames"]["get"]>): number {
    const owner = info?.snapshot.subjects.find((s) => s.owner) ?? info?.snapshot.subjects[0];
    return owner?.energy === undefined ? -1 : Math.round(owner.energy * 20) / 20;
}

/** Preview-only coaching nudges, rate-limited, plus a slim energy meter. */
export function Coach() {
    const { vision, frames } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const coach = vision.coach;
    const active = useSettledFrame(frames, ownerActive, "", 500, 1500);
    // Settled like the badges: the meter appears after 0.5 s of data and survives 2 s gaps,
    // and its value only moves on readings that hold for 150 ms.
    const energy = useSettledFrame(frames, ownerEnergy, -1, 150, 2000);
    const present = energy >= 0;
    const [nudge, setNudge] = useState<NudgeId | null>(null);
    const lastShown = useRef<Record<NudgeId, number>>({ eyeContact: 0, posture: 0, hydration: 0 });

    const lookingAway = coach.eyeContact && active.includes("look_away");
    const slouching = coach.posture && active.includes("slouch");

    useEffect(() => {
        const show = (id: NudgeId) => {
            const now = Date.now();
            if (now - lastShown.current[id] < NUDGE_COOLDOWN_MS) return;
            lastShown.current[id] = now;
            setNudge(id);
        };
        const timers: number[] = [];
        if (lookingAway) timers.push(window.setTimeout(() => show("eyeContact"), LOOK_AWAY_MS));
        if (slouching) timers.push(window.setTimeout(() => show("posture"), SLOUCH_MS));
        return () => timers.forEach((id) => window.clearTimeout(id));
    }, [lookingAway, slouching]);

    useEffect(() => {
        if (coach.hydrationMin <= 0) return;
        const id = window.setInterval(() => {
            lastShown.current.hydration = Date.now();
            setNudge("hydration");
        }, coach.hydrationMin * 60_000);
        return () => window.clearInterval(id);
    }, [coach.hydrationMin]);

    useEffect(() => {
        if (!nudge) return;
        const id = window.setTimeout(() => setNudge(null), NUDGE_SHOW_MS);
        return () => window.clearTimeout(id);
    }, [nudge]);

    const Icon = nudge ? ICONS[nudge] : null;

    return (
        <div className="pointer-events-none absolute inset-x-3 top-[max(9%,4.5rem)] flex flex-col items-center gap-2">
            <AnimatePresence>
                {nudge && Icon && (
                    <motion.div
                        key={nudge}
                        role="status"
                        initial={reduced ? false : { opacity: 0, y: -10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
                        transition={reduced ? INSTANT : SPRING}
                        className={`${GLASS} pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl py-1.5 pl-3 pr-1.5 text-xs`}
                    >
                        <Icon className="size-4 shrink-0 text-sky-300" aria-hidden />
                        <span className="min-w-0">{t(`studio.coach.${nudge}`)}</span>
                        <button
                            type="button"
                            onClick={() => setNudge(null)}
                            aria-label={t("studio.common.dismiss")}
                            className={`grid size-6 shrink-0 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}
                        >
                            <X className="size-3.5" aria-hidden />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
            <AnimatePresence>
            {coach.energy && present && (
                <motion.div
                    key="energy"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduced ? INSTANT : { duration: 0.3 }}
                    className={`${GLASS} flex items-center gap-2 rounded-full px-2.5 py-1`}
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(energy * 100)}
                    aria-label={t("studio.coach.energy")}
                >
                    <Activity className="size-3.5 text-fuchsia-300" aria-hidden />
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/15">
                        <motion.div
                            className="h-full rounded-full bg-gradient-to-r from-sky-400 via-fuchsia-400 to-amber-300"
                            animate={{ width: `${Math.max(0, energy) * 100}%` }}
                            transition={reduced ? INSTANT : SPRING}
                        />
                    </div>
                </motion.div>
            )}
            </AnimatePresence>
        </div>
    );
}
