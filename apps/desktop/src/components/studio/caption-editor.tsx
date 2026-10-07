import { CAPTION_STYLES, type CaptionSettings } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Languages, Move, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";

/** Defaults: centre between the face and TikTok's comment area (portrait), never under the top bar. */
const DEFAULT_POS = { u: 0.5, v: 0.54, scale: 1 } as const;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Drag = { mode: "move" | "resize"; x: number; y: number; u: number; v: number; scale: number; h: number };

/**
 * Move / resize handles over the LIVE caption (it is drawn into the video by CaptionLayer):
 * drag the pill to move it, drag the corner (or wheel / Alt+wheel) to resize, arrows nudge,
 * +/- scale, double-click resets. Edits apply to the engine every frame and persist once per
 * animation frame. The outline follows the real pill (controller.captionRect()).
 */
export function CaptionEditor() {
    const { controller, rect, studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const c = studio.captions;
    const [box, setBox] = useState<{ u: number; v: number; w: number; h: number } | null>(null);
    const [hover, setHover] = useState(false);
    const [dragging, setDragging] = useState<Drag["mode"] | null>(null);
    const drag = useRef<Drag | null>(null);
    const pending = useRef<Partial<CaptionSettings> | null>(null);
    const raf = useRef(0);
    const latest = useRef({ c, patchStudio });
    useEffect(() => {
        latest.current = { c, patchStudio };
    }, [c, patchStudio]);

    // Follow the real pill (its size morphs with the text).
    useEffect(() => {
        let id = 0;
        let last = "";
        const tick = () => {
            const r = controller.captionRect?.() ?? null;
            const key = r ? `${r.u.toFixed(4)},${r.v.toFixed(4)},${r.w.toFixed(4)},${r.h.toFixed(4)}` : "";
            if (key !== last) {
                last = key;
                setBox(r && r.w > 0 ? r : null);
            }
            id = requestAnimationFrame(tick);
        };
        id = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(id);
    }, [controller]);

    const commit = (p: Partial<CaptionSettings>) => {
        pending.current = { ...pending.current, ...p };
        if (raf.current) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            const next = pending.current;
            pending.current = null;
            const { c: cur, patchStudio: patch } = latest.current;
            if (next) patch({ captions: { ...cur, ...next } });
        });
    };

    useEffect(() => () => cancelAnimationFrame(raf.current), []);

    if (rect.width <= 0) return null;
    // Empty pill (nobody talking yet): show a placeholder outline where the caption will appear.
    const shown = box ?? { u: c.u, v: c.v, w: 0.42 * c.scale, h: 0.05 * c.scale };
    const left = rect.left + (shown.u - shown.w / 2) * rect.width;
    const top = rect.top + (shown.v - shown.h / 2) * rect.height;
    const width = shown.w * rect.width;
    const height = shown.h * rect.height;

    const move = (e: ReactPointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (d.mode === "move") commit({ u: clamp(d.u + dx / rect.width, 0, 1), v: clamp(d.v + dy / rect.height, 0, 1) });
        else {
            // Corner drag: scale with the vertical + horizontal pull, relative to the pill height.
            const grow = (dy + dx * 0.5) / Math.max(d.h, 24);
            commit({ scale: clamp(Math.round(d.scale * (1 + grow) * 100) / 100, MIN_SCALE, MAX_SCALE) });
        }
    };
    const end = () => {
        drag.current = null;
        setDragging(null);
    };

    const active = hover || dragging !== null;
    const style = c.style;

    return (
        <div data-studio-ui className="pointer-events-none absolute inset-0">
            <motion.div
                role="group"
                aria-label={t("studio.captions.editLabel")}
                tabIndex={0}
                className={`pointer-events-auto absolute touch-none select-none ${FOCUS_RING}`}
                style={{ cursor: dragging === "move" ? "grabbing" : "grab" }}
                initial={false}
                animate={{ left: left - 6, top: top - 6, width: width + 12, height: height + 12 }}
                transition={dragging ? INSTANT : reduced ? INSTANT : { type: "spring", bounce: 0.1, visualDuration: 0.18 }}
                onPointerEnter={() => setHover(true)}
                onPointerLeave={() => setHover(false)}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = { mode: "move", x: e.clientX, y: e.clientY, u: c.u, v: c.v, scale: c.scale, h: height };
                    setDragging("move");
                }}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onDoubleClick={() => commit({ ...DEFAULT_POS })}
                onWheel={(e) => commit({ scale: clamp(Math.round((c.scale - Math.sign(e.deltaY) * 0.05) * 100) / 100, MIN_SCALE, MAX_SCALE) })}
                onKeyDown={(e) => {
                    const step = e.shiftKey ? 0.05 : 0.01;
                    const k: Record<string, Partial<CaptionSettings>> = {
                        ArrowLeft: { u: clamp(c.u - step, 0, 1) },
                        ArrowRight: { u: clamp(c.u + step, 0, 1) },
                        ArrowUp: { v: clamp(c.v - step, 0, 1) },
                        ArrowDown: { v: clamp(c.v + step, 0, 1) },
                        "+": { scale: clamp(c.scale + 0.05, MIN_SCALE, MAX_SCALE) },
                        "=": { scale: clamp(c.scale + 0.05, MIN_SCALE, MAX_SCALE) },
                        "-": { scale: clamp(c.scale - 0.05, MIN_SCALE, MAX_SCALE) },
                    };
                    const p = k[e.key];
                    if (!p) return;
                    e.preventDefault();
                    e.stopPropagation();
                    commit(p);
                }}
            >
                {/* Outline: dashed when idle, glowing while hovered/dragged. */}
                <motion.div
                    className="absolute inset-0 rounded-[1.1rem] border-2"
                    animate={{
                        borderColor: active ? "rgb(125 211 252 / 0.95)" : "rgb(255 255 255 / 0.35)",
                        boxShadow: active ? "0 0 0 4px rgb(56 189 248 / 0.18), 0 0 24px rgb(56 189 248 / 0.35)" : "0 0 0 0 rgb(0 0 0 / 0)",
                    }}
                    style={{ borderStyle: active ? "solid" : "dashed" }}
                    transition={reduced ? INSTANT : SPRING}
                />
                {!box && (
                    <span className="absolute inset-0 grid place-items-center text-[0.6875rem] font-medium text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
                        {t("studio.captions.placeholder")}
                    </span>
                )}
                {/* Resize handle (bottom-right corner). */}
                <AnimatePresence>
                    {active && (
                        <motion.button
                            type="button"
                            aria-label={t("studio.captions.resize")}
                            initial={reduced ? false : { scale: 0.4, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.4, opacity: 0 }}
                            transition={reduced ? INSTANT : SPRING}
                            className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full border-2 border-white bg-sky-400 shadow-md"
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                e.currentTarget.setPointerCapture(e.pointerId);
                                drag.current = { mode: "resize", x: e.clientX, y: e.clientY, u: c.u, v: c.v, scale: c.scale, h: height };
                                setDragging("resize");
                            }}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={end}
                        />
                    )}
                </AnimatePresence>
            </motion.div>

            {/* Floating toolbar above the pill: style, translation badge, reset. */}
            <AnimatePresence>
                {active && dragging === null && (
                    <motion.div
                        key="bar"
                        className={`${GLASS} pointer-events-auto absolute flex items-center gap-1 rounded-full px-1.5 py-1 text-[0.6875rem]`}
                        style={{ left: left + width / 2, top: Math.max(rect.top + 4, top - 40), x: "-50%" }}
                        initial={reduced ? false : { opacity: 0, y: 6, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.95 }}
                        transition={reduced ? INSTANT : SPRING}
                        onPointerEnter={() => setHover(true)}
                        onPointerLeave={() => setHover(false)}
                    >
                        <Move className="ml-1 size-3.5 text-white/70" aria-hidden />
                        {CAPTION_STYLES.map((s) => (
                            <button
                                key={s}
                                type="button"
                                aria-pressed={style === s}
                                onClick={() => commit({ style: s })}
                                className={`rounded-full px-2 py-0.5 transition-colors ${FOCUS_RING} ${style === s ? "bg-white text-neutral-900" : "text-white hover:bg-white/15"}`}
                            >
                                {t(`studio.captions.styles.${s}`)}
                            </button>
                        ))}
                        {c.translate && (
                            <span className="flex items-center gap-1 rounded-full bg-sky-400/20 px-2 py-0.5 text-sky-100">
                                <Languages className="size-3" aria-hidden />
                                {c.lang.toUpperCase()}
                            </span>
                        )}
                        <span className="px-1 tabular-nums text-white/70">{Math.round(c.scale * 100)}%</span>
                        <button type="button" onClick={() => commit({ ...DEFAULT_POS })} aria-label={t("studio.captions.reset")} className={`grid size-6 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}>
                            <RotateCcw className="size-3.5" aria-hidden />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
