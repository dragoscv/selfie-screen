import { CAPTION_STYLES, type CaptionSettings } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Languages, Move, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { clampCentre } from "../../lib/studio/caption-draw.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";

/** Defaults: centre between the face and TikTok's comment area (portrait), never under the top bar. */
const DEFAULT_POS = { u: 0.5, v: 0.54, scale: 1 } as const;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Hover grace so the pointer can travel from the pill to its toolbar. */
const HOVER_OUT_MS = 350;

/**
 * Drag start. Move: pointer offset from the DISPLAYED centre (the clamped one, so there is no
 * dead zone after the strip was pushed against an edge). Resize: distance pointer -> centre.
 */
type Drag = { mode: "move" | "resize"; x: number; y: number; u: number; v: number; scale: number; dist: number; cx: number; cy: number; w: number; h: number };

/**
 * Move / resize handles over the LIVE caption (it is drawn into the video by CaptionLayer):
 * drag the pill to move it, drag the corner (or wheel / Alt+wheel) to resize, arrows nudge,
 * +/- scale, double-click resets. Edits apply to the engine every frame and persist once per
 * animation frame. The outline follows the real pill (controller.captionRect()).
 */
export function CaptionEditor() {
    const { controller, rect, studio, patchStudio, setEditing } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const c = studio.captions;
    const [box, setBox] = useState<{ u: number; v: number; w: number; h: number } | null>(null);
    const [hover, setHover] = useState(false);
    const hoverTimer = useRef(0);
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

    useEffect(
        () => () => {
            cancelAnimationFrame(raf.current);
            window.clearTimeout(hoverTimer.current);
        },
        [],
    );
    const hoverOn = () => {
        window.clearTimeout(hoverTimer.current);
        setHover(true);
    };
    const hoverOff = () => {
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = window.setTimeout(() => setHover(false), HOVER_OUT_MS);
    };

    // Keep the studio chrome (and so this editor) shown while the pointer is on it or dragging:
    // the 3 s idle timer used to hide the chrome mid-drag, unmounting the editor and dropping the drag.
    const active = hover || dragging !== null;
    useEffect(() => {
        setEditing?.(active);
    }, [active, setEditing]);
    useEffect(() => () => setEditing?.(false), [setEditing]);

    if (rect.width <= 0) return null;
    // Empty pill (nobody talking yet): a placeholder outline where the caption will appear,
    // clamped exactly like the real strip.
    const ph = { w: 0.42 * c.scale, h: 0.05 * c.scale };
    const shown = box ?? { ...clampCentre(c.u, c.v, ph.w, ph.h), ...ph };
    const left = rect.left + (shown.u - shown.w / 2) * rect.width;
    const top = rect.top + (shown.v - shown.h / 2) * rect.height;
    const width = shown.w * rect.width;
    const height = shown.h * rect.height;
    const centreX = left + width / 2;
    const centreY = top + height / 2;

    const begin = (e: ReactPointerEvent<HTMLElement>, mode: Drag["mode"]): Drag => ({
        mode,
        x: e.clientX,
        y: e.clientY,
        u: shown.u,
        v: shown.v,
        scale: c.scale,
        cx: centreX,
        cy: centreY,
        dist: Math.max(12, Math.hypot(e.clientX - centreX, e.clientY - centreY)),
        w: shown.w,
        h: shown.h,
    });

    const move = (e: ReactPointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d) return;
        if (d.mode === "move") {
            // Saved position = the visible one (never beyond the frame clamp, so no dead zone later).
            const p = clampCentre(d.u + (e.clientX - d.x) / rect.width, d.v + (e.clientY - d.y) / rect.height, d.w, d.h);
            commit({ u: p.u, v: p.v });
        } else {
            // Corner drag: scale follows the pointer's distance from the centre (1:1 with the corner).
            const ratio = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d.dist;
            commit({ scale: clamp(Math.round(d.scale * ratio * 100) / 100, MIN_SCALE, MAX_SCALE) });
        }
    };
    const end = () => {
        drag.current = null;
        setDragging(null);
    };

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
                onPointerEnter={hoverOn}
                onPointerLeave={hoverOff}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = begin(e, "move");
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
                {/* Resize handle (bottom-right corner): 28 px hit area, dot grows when active. */}
                <button
                    type="button"
                    aria-label={t("studio.captions.resize")}
                    className="absolute -bottom-3.5 -right-3.5 grid size-7 cursor-nwse-resize touch-none place-items-center"
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = begin(e, "resize");
                        setDragging("resize");
                    }}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                >
                    <motion.span
                        aria-hidden
                        className="block rounded-full border-2 border-white bg-sky-400 shadow-md"
                        animate={{ width: active ? 16 : 10, height: active ? 16 : 10, opacity: active ? 1 : 0.7 }}
                        transition={reduced ? INSTANT : SPRING}
                    />
                </button>
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
                        onPointerEnter={hoverOn}
                        onPointerLeave={hoverOff}
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
