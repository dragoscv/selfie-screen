import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Crown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { INSTANT, useFrame, useLingering, useStudio } from "./context.js";

const FOLLOW = { type: "spring", bounce: 0.1, visualDuration: 0.18 } as const;
const FADE = { duration: 0.25, ease: "easeOut" } as const;
const EMPTY: readonly never[] = [];

/** Four L-shaped corners; colour comes from `currentColor`. */
function Brackets({ thick }: { thick: boolean }) {
    const w = thick ? "border-[3px]" : "border-2";
    const len = "size-[22%] min-h-3 min-w-3 max-h-6 max-w-6";
    return (
        <>
            <span className={`absolute left-0 top-0 ${len} ${w} rounded-tl-md border-current border-b-0 border-r-0`} />
            <span className={`absolute right-0 top-0 ${len} ${w} rounded-tr-md border-current border-b-0 border-l-0`} />
            <span className={`absolute bottom-0 left-0 ${len} ${w} rounded-bl-md border-current border-r-0 border-t-0`} />
            <span className={`absolute bottom-0 right-0 ${len} ${w} rounded-br-md border-current border-l-0 border-t-0`} />
        </>
    );
}

/** Face boxes (green when the camera reports focus) and dog boxes, spring-following the detections. */
export function AfBoxes() {
    const { frames, rect } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const faces = useLingering(frames, (i) => i?.faces ?? EMPTY, (f) => `f${f.track}`);
    const dogs = useLingering(frames, (i) => i?.dogs ?? EMPTY, (d) => `d${d.track}`, 300, 800);
    const focused = useFrame(frames, (i) => i?.camera.focused ?? false);
    const transition = reduced ? INSTANT : FOLLOW;
    if (rect.width <= 0) return null;

    const place = (b: { x: number; y: number; w: number; h: number }) => ({
        left: rect.left + b.x * rect.width,
        top: rect.top + b.y * rect.height,
        width: b.w * rect.width,
        height: b.h * rect.height,
    });

    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
            <AnimatePresence>
                {faces.map((f) => (
                    <motion.div
                        key={`f${f.track}`}
                        className={`absolute ${focused && f.owner ? "text-emerald-400" : "text-white/85"} drop-shadow-[0_0_4px_rgb(0_0_0/0.8)]`}
                        initial={{ ...place(f), opacity: 0, scale: reduced ? 1 : 1.15 }}
                        animate={{ ...place(f), opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, transition: FADE }}
                        transition={{ ...transition, opacity: FADE }}
                    >
                        <Brackets thick={f.owner} />
                        <span className="absolute -top-6 left-0 flex items-center gap-1 whitespace-nowrap rounded-md bg-black/70 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">
                            {f.owner && <Crown className="size-3 text-amber-300" />}
                            {f.name ?? t("studio.af.unknown")}
                        </span>
                    </motion.div>
                ))}
                {dogs.map((d) => (
                    <motion.div
                        key={`d${d.track}`}
                        className="absolute text-fuchsia-300 drop-shadow-[0_0_4px_rgb(0_0_0/0.8)]"
                        initial={{ ...place(d), opacity: 0 }}
                        animate={{ ...place(d), opacity: 1 }}
                        exit={{ opacity: 0, transition: FADE }}
                        transition={{ ...transition, opacity: FADE }}
                    >
                        <Brackets thick={false} />
                        <span className="absolute -top-6 left-0 whitespace-nowrap rounded-md bg-black/70 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-fuchsia-200">
                            🐾 {d.name ?? t("studio.af.dog")} · {Math.round(d.confidence * 100)}%
                        </span>
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
}
