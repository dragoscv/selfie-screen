import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { INSTANT, SPRING } from "./context.js";
import { subscribeMicFeed } from "./mic-feed.js";

/** Final lines kept on screen and how long a line stays after it was said. */
const LINES = 2;
const LINE_TTL_MS = 8_000;

interface Line {
    key: string;
    text: string;
    at: number;
}

/**
 * Live transcript captions (Monitor → Audio → Transcript, preview only). Lives in the bottom
 * column of the studio chrome, above the dock, so it never covers the status bar, the scopes
 * or the panels: a broadcast-style caption strip, not a floating window.
 */
export function Captions() {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [lines, setLines] = useState<Line[]>([]);
    const [partial, setPartial] = useState("");
    const [state, setState] = useState<"off" | "live" | "offline">("off");

    useEffect(
        () =>
            subscribeMicFeed((p) => {
                const d = p.diag;
                setState(!p.enabled ? "off" : d?.ws === "open" ? "live" : "offline");
                setPartial(d?.partial ?? "");
                const finals = p.events.filter((e) => e.kind === "final");
                if (finals.length > 0) {
                    setLines((prev) => [...prev, ...finals.map((f, i) => ({ key: `${f.at}-${i}`, text: f.text, at: f.at }))].slice(-LINES));
                }
            }),
        [],
    );

    // Old lines fade out on their own so the strip collapses when nobody talks.
    useEffect(() => {
        if (lines.length === 0) return;
        const oldest = Math.min(...lines.map((l) => l.at));
        const id = window.setTimeout(() => setLines((prev) => prev.filter((l) => Date.now() - l.at < LINE_TTL_MS)), Math.max(200, oldest + LINE_TTL_MS - Date.now()));
        return () => window.clearTimeout(id);
    }, [lines]);

    const hint = state === "off" ? t("studio.captions.off") : state === "offline" ? t("studio.captions.offline") : null;
    const empty = lines.length === 0 && partial === "";

    return (
        <div role="log" aria-live="polite" aria-label={t("studio.captions.label")} className="flex max-w-[min(40rem,100%)] flex-col items-center gap-1 text-center">
            <AnimatePresence initial={false}>
                {lines.map((l) => (
                    <motion.p
                        key={l.key}
                        layout={!reduced}
                        initial={reduced ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 0.8, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={reduced ? INSTANT : SPRING}
                        className="rounded-lg bg-black/60 px-2.5 py-0.5 text-[0.8125rem] leading-snug text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]"
                    >
                        {l.text}
                    </motion.p>
                ))}
            </AnimatePresence>
            {partial !== "" && (
                <p className="rounded-lg bg-black/70 px-3 py-1 text-[0.9375rem] font-semibold leading-snug text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">{partial}</p>
            )}
            {empty && (
                <p className="rounded-full bg-black/50 px-3 py-0.5 text-[0.6875rem] text-white/70">{hint ?? t("studio.captions.listening")}</p>
            )}
        </div>
    );
}
