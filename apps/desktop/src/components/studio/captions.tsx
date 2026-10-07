import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { INSTANT, SPRING, useStudio } from "./context.js";
import { useCaptionSnapshot } from "./use-captions.js";

/**
 * Live transcript captions in the PREVIEW only (Monitor → Audio → Transcript with "show on
 * live" off): a broadcast-style strip above the dock that never covers the status bar, the
 * scopes or the panels. With "show on live" on, the caption is part of the video itself
 * (CaptionLayer) and the preview shows move/resize handles instead (CaptionEditor).
 */
export function Captions() {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const { studio } = useStudio();
    const { lines, partial, state } = useCaptionSnapshot(studio.captions.lines);
    const translate = studio.captions.translate;
    const rows = studio.captions.rows;
    const hint = state === "off" ? t("studio.captions.off") : state === "offline" ? t("studio.captions.offline") : null;
    const empty = lines.length === 0 && partial === "";
    // The sentence being spoken shows at most `rows` rows and scrolls so the newest words stay visible.
    const live = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
        const el = live.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    }, [partial, reduced]);

    return (
        <motion.div
            role="log"
            aria-live="polite"
            aria-label={t("studio.captions.label")}
            layout={!reduced}
            transition={reduced ? INSTANT : SPRING}
            className="flex max-w-[min(40rem,100%)] flex-col items-center gap-0.5 overflow-hidden rounded-2xl border border-white/15 bg-neutral-950/60 px-3 py-1.5 text-center shadow-[0_8px_32px_rgb(0_0_0/0.45)] backdrop-blur-xl"
        >
            <AnimatePresence initial={false} mode="popLayout">
                {lines.map((l) => (
                    <motion.div
                        key={l.key}
                        layout={!reduced}
                        initial={reduced ? false : { opacity: 0, y: 10, filter: "blur(4px)" }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
                        transition={reduced ? INSTANT : SPRING}
                        className="leading-snug"
                    >
                        <p className="text-[0.8125rem] text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">{l.text}</p>
                        {translate && l.translated && (
                            <motion.p initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? INSTANT : SPRING} className="text-[0.8125rem] italic text-sky-200">
                                {l.translated}
                            </motion.p>
                        )}
                    </motion.div>
                ))}
            </AnimatePresence>
            {partial !== "" && (
                <motion.p
                    ref={live}
                    layout={!reduced}
                    style={{ maxHeight: `${rows * 1.375}em` }}
                    className="overflow-y-auto text-[0.9375rem] font-semibold leading-snug text-white [scrollbar-width:none] [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]"
                >
                    {partial}
                </motion.p>
            )}
            {empty && <p className="text-[0.6875rem] text-white/70">{hint ?? t("studio.captions.listening")}</p>}
        </motion.div>
    );
}
