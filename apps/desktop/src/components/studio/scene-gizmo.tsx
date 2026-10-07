import type { ArObject, StudioSettings } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Pin, PinOff } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import type { SceneObject } from "../../lib/studio/controller.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";
import { gizmoDrag, startOf as startFrom, wrapDeg, type GizmoMode, type GizmoStart } from "./scene-gizmo-math.js";

export type SceneSel = { kind: "ar" | "pet"; id: string } | null;

/**
 * In-view 3D editor for every scene object (AR objects AND pets): click to select, drag the body
 * to move on screen, the red / green / blue arrows to move along X / Y / Z (depth), the corner to
 * resize, the ring to turn (Shift = roll for AR objects). Wheel = depth, Alt+wheel = size.
 * Pets are pinned where you leave them (petPins) until released; sizes persist (petHands.scale).
 */
export function SceneGizmo({ sel, onSel }: { sel: SceneSel; onSel: (s: SceneSel) => void }) {
    const { controller, rect, studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [objects, setObjects] = useState<SceneObject[]>([]);
    const capture = useRef<HTMLDivElement>(null);
    const drag = useRef<(GizmoStart & { mode: GizmoMode; kind: "ar" | "pet"; id: string }) | null>(null);
    const [dragging, setDragging] = useState<GizmoMode | null>(null);
    const latest = useRef(studio);
    const pending = useRef<Partial<StudioSettings> | null>(null);
    const raf = useRef(0);

    useEffect(() => {
        if (!pending.current) latest.current = studio;
    }, [studio]);
    useEffect(() => () => cancelAnimationFrame(raf.current), []);

    // Follow the objects on screen (pets move and bob every frame).
    useEffect(() => {
        let id = 0;
        let last = "";
        const tick = () => {
            const list = controller.sceneObjects?.() ?? [];
            const key = list.map((o) => `${o.kind}${o.id}${o.box.x.toFixed(3)}${o.box.y.toFixed(3)}${o.box.w.toFixed(3)}${o.box.h.toFixed(3)}${o.pinned ? 1 : 0}`).join("|");
            if (key !== last) {
                last = key;
                setObjects(list);
            }
            id = requestAnimationFrame(tick);
        };
        id = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(id);
    }, [controller]);

    /** Merge into the latest settings and persist once per frame. */
    const apply = (p: Partial<StudioSettings>) => {
        latest.current = { ...latest.current, ...p };
        pending.current = { ...pending.current, ...p };
        if (raf.current) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            const next = pending.current;
            pending.current = null;
            if (next) patchStudio(next);
        });
    };
    const setAr = (id: string, p: Partial<ArObject>) => apply({ arObjects: latest.current.arObjects.map((o) => (o.id === id ? { ...o, ...p } : o)) });
    const setPet = (id: string, pin: { x: number; y: number; z: number; yaw: number }, scale?: number) => {
        const cur = latest.current;
        apply({
            petPins: { ...cur.petPins, [id]: pin },
            ...(scale !== undefined ? { petHands: { ...cur.petHands, scale: { ...cur.petHands.scale, [id]: scale } } } : {}),
        });
    };
    const release = (id: string) => {
        const pins = { ...latest.current.petPins };
        delete pins[id];
        apply({ petPins: pins });
    };

    const selObj = sel ? (objects.find((o) => o.kind === sel.kind && o.id === sel.id) ?? null) : null;

    /** Start values in event handlers: the latest (possibly not yet rendered) settings. */
    const startOf = (o: SceneObject): GizmoStart | null => startFrom(latest.current, o);

    const begin = (e: ReactPointerEvent<HTMLElement>, o: SceneObject, mode: GizmoMode) => {
        const st = startOf(o);
        if (!st) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const cx = rect.left + (o.box.x + o.box.w / 2) * rect.width;
        const cy = rect.top + (o.box.y + o.box.h / 2) * rect.height;
        drag.current = { ...st, mode, kind: o.kind, id: o.id, px: e.clientX, py: e.clientY, cx, cy, dist: Math.max(16, Math.hypot(e.clientX - cx, e.clientY - cy)) };
        setDragging(mode);
    };

    const move = (e: ReactPointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || rect.width <= 0) return;
        const r = gizmoDrag(d, e.clientX, e.clientY, rect.width, rect.height, e.shiftKey && d.kind === "ar");
        if (d.kind === "ar") setAr(d.id, { x: r.x, y: r.y, z: r.z, size: r.size, yaw: r.yaw, rotation: r.roll });
        else setPet(d.id, { x: r.x, y: r.y, z: r.z, yaw: r.yaw }, r.size);
    };
    const end = () => {
        drag.current = null;
        setDragging(null);
    };

    // Non-passive wheel on the capture layer: depth, Alt = size.
    useEffect(() => {
        const el = capture.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            const o = selObj;
            if (!o) return;
            const st = startOf(o);
            if (!st) return;
            e.preventDefault();
            const n = -Math.sign(e.deltaY);
            const size = Math.min(st.sizeMax, Math.max(st.sizeMin, st.size * (1 + n * 0.08)));
            const z = Math.min(6, Math.max(0.3, st.z * (1 + n * 0.06)));
            if (o.kind === "ar") setAr(o.id, e.altKey ? { size } : { z });
            else setPet(o.id, { x: st.x, y: st.y, z: e.altKey ? st.z : z, yaw: st.yaw }, e.altKey ? size : undefined);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    });

    const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!selObj) return;
        const st = startOf(selObj);
        if (!st) return;
        const step = e.shiftKey ? 0.05 : 0.01;
        const next = { ...st };
        if (e.key === "ArrowLeft") next.x -= step;
        else if (e.key === "ArrowRight") next.x += step;
        else if (e.key === "ArrowUp") next.y -= step;
        else if (e.key === "ArrowDown") next.y += step;
        else if (e.key === "PageUp") next.z = Math.min(6, st.z * 1.06);
        else if (e.key === "PageDown") next.z = Math.max(0.3, st.z / 1.06);
        else if (e.key === "+" || e.key === "=") next.size = Math.min(st.sizeMax, st.size * 1.08);
        else if (e.key === "-") next.size = Math.max(st.sizeMin, st.size / 1.08);
        else if (e.key === "[") next.yaw = wrapDeg(st.yaw - 15);
        else if (e.key === "]") next.yaw = wrapDeg(st.yaw + 15);
        else if (e.key === "Escape") {
            onSel(null);
            return;
        } else return;
        e.preventDefault();
        e.stopPropagation();
        if (selObj.kind === "ar") setAr(selObj.id, { x: next.x, y: next.y, z: next.z, size: next.size, yaw: next.yaw });
        else setPet(selObj.id, { x: next.x, y: next.y, z: next.z, yaw: next.yaw }, next.size);
    };

    if (rect.width <= 0) return null;
    const toPx = (b: SceneObject["box"]) => ({ left: rect.left + b.x * rect.width, top: rect.top + b.y * rect.height, width: b.w * rect.width, height: b.h * rect.height });
    const label = (o: SceneObject) => (o.kind === "pet" ? t(`studio.pets.${o.id}`, { defaultValue: o.id }) : (studio.arObjects.find((a) => a.id === o.id)?.name ?? o.id));

    const sb = selObj ? toPx(selObj.box) : null;
    // Render reads the committed settings (props), never the ref.
    const st = selObj ? startFrom(studio, selObj) : null;
    const cx = sb ? sb.left + sb.width / 2 : 0;
    const cy = sb ? sb.top + sb.height / 2 : 0;
    const arm = sb ? Math.max(36, Math.min(72, Math.max(sb.width, sb.height) * 0.6)) : 0;

    return (
        <>
            {/* Capture: click an object to select it (nearest wins), empty space deselects. */}
            <div
                ref={capture}
                tabIndex={0}
                role="application"
                aria-label={t("studio.ar.gizmo.label")}
                className={`absolute cursor-crosshair rounded-sm ring-1 ring-inset ring-sky-300/40 ${FOCUS_RING}`}
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                onKeyDown={onKey}
                onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const box = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - box.left) / box.width;
                    const ny = (e.clientY - box.top) / box.height;
                    const hit = objects.find((o) => nx >= o.box.x && nx <= o.box.x + o.box.w && ny >= o.box.y && ny <= o.box.y + o.box.h);
                    if (!hit) {
                        onSel(null);
                        return;
                    }
                    onSel({ kind: hit.kind, id: hit.id });
                    begin(e, hit, "move");
                }}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
            />

            {/* Every object: a faint outline so you see what can be grabbed. */}
            {objects.map((o) => {
                const b = toPx(o.box);
                const on = selObj?.kind === o.kind && selObj.id === o.id;
                return (
                    <div
                        key={`${o.kind}-${o.id}`}
                        aria-hidden
                        className={`pointer-events-none absolute rounded-lg border ${on ? "border-transparent" : o.kind === "pet" ? "border-dashed border-fuchsia-300/60" : "border-dashed border-sky-300/60"}`}
                        style={b}
                    >
                        {!on && (
                            <span className="absolute -top-5 left-0 whitespace-nowrap rounded-full bg-black/60 px-1.5 text-[0.625rem] text-white/85">
                                {o.kind === "pet" && o.pinned ? "📌 " : ""}
                                {label(o)}
                            </span>
                        )}
                    </div>
                );
            })}

            {/* Selected: box + gizmo handles. */}
            <AnimatePresence>
                {selObj && sb && st && (
                    <motion.div
                        key={`${selObj.kind}-${selObj.id}`}
                        className="pointer-events-none absolute inset-0"
                        initial={reduced ? false : { opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={reduced ? INSTANT : SPRING}
                    >
                        <div
                            className="pointer-events-auto absolute cursor-move touch-none rounded-lg border-2 border-amber-300 shadow-[0_0_0_4px_rgb(252_211_77/0.15),0_0_20px_rgb(252_211_77/0.35)]"
                            style={sb}
                            onPointerDown={(e) => begin(e, selObj, "move")}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={end}
                        />
                        {/* X (red, right), Y (green, up), Z (blue, into the scene, up-right). */}
                        <Arrow x={cx} y={cy} dx={arm} dy={0} color="#f87171" label="X" title={t("studio.ar.gizmo.x")} onPointerDown={(e) => begin(e, selObj, "x")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
                        <Arrow x={cx} y={cy} dx={0} dy={-arm} color="#4ade80" label="Y" title={t("studio.ar.gizmo.y")} onPointerDown={(e) => begin(e, selObj, "y")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
                        <Arrow
                            x={cx}
                            y={cy}
                            dx={arm * 0.72}
                            dy={-arm * 0.72}
                            color="#60a5fa"
                            label="Z"
                            title={t("studio.ar.gizmo.z")}
                            dashed
                            onPointerDown={(e) => begin(e, selObj, "z")}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={end}
                        />
                        {/* Rotate ring above the box. */}
                        <button
                            type="button"
                            aria-label={t("studio.ar.gizmo.rotate")}
                            title={t("studio.ar.gizmo.rotateHint")}
                            className="pointer-events-auto absolute grid size-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none place-items-center rounded-full border-2 border-amber-200 bg-neutral-950/70 text-[0.75rem] text-amber-100 shadow-md"
                            style={{ left: cx, top: sb.top - 22 }}
                            onPointerDown={(e) => begin(e, selObj, "rotate")}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={end}
                        >
                            ⟳
                        </button>
                        {/* Resize corner. */}
                        <button
                            type="button"
                            aria-label={t("studio.ar.gizmo.scale")}
                            className="pointer-events-auto absolute grid size-7 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize touch-none place-items-center"
                            style={{ left: sb.left + sb.width, top: sb.top + sb.height }}
                            onPointerDown={(e) => begin(e, selObj, "scale")}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={end}
                        >
                            <span className="block size-3.5 rounded-sm border-2 border-white bg-amber-300 shadow" aria-hidden />
                        </button>
                        {/* Readout + pin/release. */}
                        <div
                            className={`${GLASS} pointer-events-auto absolute flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] tabular-nums`}
                            style={{ left: cx, top: Math.min(rect.top + rect.height - 30, sb.top + sb.height + 14) }}
                        >
                            <span className="font-semibold">{label(selObj)}</span>
                            <span className="text-white/75">
                                {dragging === "z" || dragging === null ? `${st.z.toFixed(2)} m` : ""}
                                {dragging === "scale" ? `${selObj.kind === "pet" ? `${Math.round(st.size * 100)}%` : `${st.size.toFixed(2)} m`}` : ""}
                                {dragging === "rotate" ? `${Math.round(st.yaw)}°` : ""}
                                {dragging === "move" || dragging === "x" || dragging === "y" ? `x ${st.x.toFixed(2)} · y ${st.y.toFixed(2)}` : ""}
                            </span>
                            {selObj.kind === "pet" &&
                                (selObj.pinned ? (
                                    <button type="button" onClick={() => release(selObj.id)} className={`flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 hover:bg-white/25 ${FOCUS_RING}`}>
                                        <PinOff className="size-3" aria-hidden />
                                        {t("studio.ar.gizmo.release")}
                                    </button>
                                ) : (
                                    <span className="flex items-center gap-1 text-white/70">
                                        <Pin className="size-3" aria-hidden />
                                        {t("studio.ar.gizmo.pinHint")}
                                    </span>
                                ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}

/** An axis handle: a line from the centre with a grabbable arrow head. */
function Arrow({
    x,
    y,
    dx,
    dy,
    color,
    label,
    title,
    dashed,
    ...h
}: {
    x: number;
    y: number;
    dx: number;
    dy: number;
    color: string;
    label: string;
    title: string;
    dashed?: boolean;
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
}) {
    const len = Math.hypot(dx, dy);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    return (
        <>
            <div
                aria-hidden
                className="pointer-events-none absolute origin-left"
                style={{ left: x, top: y - 1, width: len, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`, transform: `rotate(${ang}deg)`, filter: "drop-shadow(0 0 2px rgb(0 0 0 / 0.8))" }}
            />
            <button
                type="button"
                aria-label={title}
                title={title}
                className="pointer-events-auto absolute grid size-6 -translate-x-1/2 -translate-y-1/2 touch-none place-items-center rounded-full text-[0.625rem] font-bold text-neutral-950 shadow-md"
                style={{ left: x + dx, top: y + dy, background: color, cursor: dx === 0 ? "ns-resize" : dy === 0 ? "ew-resize" : "nesw-resize" }}
                {...h}
            >
                {label}
            </button>
        </>
    );
}
