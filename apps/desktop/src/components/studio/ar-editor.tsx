import { PET_CHOICES, type ArObject } from "@tiksee/core";
import { SliderRow, SwitchRow } from "@tiksee/ui";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronUp, Eye, EyeOff, ImagePlus, Smile, Trash2, Type, X, PawPrint } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { FOCUS_RING, GLASS, INSTANT, SPRING, useFrame, useStudio } from "./context.js";
import { DEPTH_MAX_M, DEPTH_MIN_M, clamp, depthToPos, posToDepth, stepDepth, toNormalised } from "./geometry.js";
import type { SceneSel } from "./scene-gizmo.js";

const SceneGizmo = lazy(() => import("./scene-gizmo.js").then((m) => ({ default: m.SceneGizmo })));

const EMOJIS = ["❤️", "⭐", "🔥", "✨", "🎉", "🌈", "🎈", "🎁", "👑", "💎", "🍀", "🌸", "🦋", "🐶", "🐱", "🦜", "🍕", "☕", "🎵", "💬", "👋", "😎", "🚀", "🌙"] as const;
const PETS = PET_CHOICES.filter((p) => p !== "none");
const ANIMATIONS = ["none", "spin", "bob", "pulse"] as const;
const ANCHORS = ["world", "head", "leftShoulder", "rightShoulder", "leftHand", "rightHand"] as const;
const MAX_IMAGE_CHARS = 300_000;
const RULER_TICKS = [0.5, 1, 2, 4] as const;

type Draft = Omit<ArObject, "id">;

const newId = () => `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Downscale until the data URL fits the budget (WebP, then smaller). */
async function imageToDataUrl(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file);
    try {
        const canvas = document.createElement("canvas");
        const g = canvas.getContext("2d");
        if (!g) throw new Error("2d context unavailable");
        let side = 768;
        for (let attempt = 0; attempt < 8; attempt++) {
            const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const url = canvas.toDataURL("image/webp", 0.82);
            if (url.length <= MAX_IMAGE_CHARS) return url;
            side = Math.round(side * 0.75);
        }
        throw new Error("image too large");
    } finally {
        bitmap.close();
    }
}

function ObjectGlyph({ o }: { o: ArObject }) {
    if (o.kind === "image") return <img src={o.content} alt="" className="size-5 rounded object-cover" />;
    if (o.kind === "text") return <Type className="size-4" aria-hidden />;
    if (o.kind === "model") return <PawPrint className="size-4" aria-hidden />;
    return <span className="text-base leading-none">{o.content}</span>;
}

/** Vertical log-scale depth ruler: owner marker, object chips (drag to change z), walk-through line. */
function DepthRuler({ objects, selected, onSelect, onDepth }: { objects: readonly ArObject[]; selected: string | null; onSelect: (id: string) => void; onDepth: (id: string, z: number) => void }) {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const track = useRef<HTMLDivElement>(null);
    const owner = useFrame(frames, (i) => (i?.ownerDistanceM === undefined ? null : Math.round(i.ownerDistanceM * 50) / 50));
    const sel = objects.find((o) => o.id === selected);
    // Bottom = near, top = far.
    const top = (m: number) => `${(1 - depthToPos(m)) * 100}%`;

    const dragTo = (id: string, e: ReactPointerEvent) => {
        const r = track.current?.getBoundingClientRect();
        if (!r || r.height <= 0) return;
        onDepth(id, posToDepth(1 - (e.clientY - r.top) / r.height));
    };

    return (
        <div className={`${GLASS} pointer-events-auto flex h-[min(62vh,30rem)] w-28 flex-col rounded-2xl px-2 py-3`} aria-label={t("studio.ar.ruler.label")} role="group">
            <span className="text-center text-[0.625rem] font-semibold uppercase tracking-wider text-white/70">{t("studio.ar.ruler.far", { m: DEPTH_MAX_M })}</span>
            <div ref={track} className="relative mx-auto my-2 w-full flex-1">
                <div className="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-gradient-to-b from-white/10 to-white/30" />
                {RULER_TICKS.map((m) => (
                    <div key={m} className="absolute left-0 right-0 flex items-center gap-1 text-[0.5625rem] text-white/60" style={{ top: top(m) }}>
                        <span className="h-px w-2 bg-white/40" />
                        {m} m
                    </div>
                ))}
                {sel && (
                    <motion.div
                        className="absolute -left-1 -right-1 border-t-2 border-dashed border-amber-300"
                        animate={{ top: top(sel.z) }}
                        transition={reduced ? INSTANT : SPRING}
                        aria-hidden
                    />
                )}
                {owner !== null && (
                    <motion.div
                        className="absolute left-0 flex -translate-y-1/2 items-center gap-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[0.625rem] font-bold text-neutral-950"
                        animate={{ top: top(owner) }}
                        transition={reduced ? INSTANT : SPRING}
                        role="img"
                        aria-label={t("studio.ar.ruler.you", { m: owner.toFixed(2) })}
                    >
                        🧍 {owner.toFixed(1)}
                    </motion.div>
                )}
                {objects.map((o) => (
                    <button
                        key={o.id}
                        type="button"
                        aria-label={t("studio.ar.ruler.chip", { name: o.name, m: o.z.toFixed(2) })}
                        aria-pressed={o.id === selected}
                        onPointerDown={(e) => {
                            e.currentTarget.setPointerCapture(e.pointerId);
                            onSelect(o.id);
                        }}
                        onPointerMove={(e) => {
                            if (e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(o.id, e);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                                e.preventDefault();
                                onDepth(o.id, stepDepth(o.z, e.key === "ArrowUp" ? 1 : -1));
                            }
                        }}
                        className={`absolute right-0 grid size-7 -translate-y-1/2 place-items-center rounded-full border text-white shadow ${FOCUS_RING} ${
                            o.id === selected ? "border-amber-300 bg-amber-400/30" : "border-white/30 bg-neutral-900/90"
                        }`}
                        style={{ top: top(o.z) }}
                    >
                        <ObjectGlyph o={o} />
                    </button>
                ))}
            </div>
            <span className="text-center text-[0.625rem] font-semibold uppercase tracking-wider text-white/70">{t("studio.ar.ruler.near", { m: DEPTH_MIN_M })}</span>
            {sel && <p className="mt-2 text-center text-[0.625rem] leading-snug text-amber-100">{t("studio.ar.ruler.walk")}</p>}
        </div>
    );
}

/**
 * AR placement editor. The capture layer over the displayed image turns
 * clicks into picks, drags into x/y moves (Shift = rotate), wheel into depth
 * (Alt = size). Keyboard: arrows x/y, PageUp/PageDown z, +/- size.
 */
export function ArEditor({ onClose }: { onClose: () => void }) {
    const { studio, controller, rect, patchStudio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const objects = studio.arObjects;
    const [selected, setSelected] = useState<string | null>(objects[0]?.id ?? null);
    const [picker, setPicker] = useState(false);
    const [text, setText] = useState("");
    /** In-view 3D editing (gizmo for AR objects and pets); remembered for the session. */
    const [inView, setInView] = useState(() => sessionStorage.getItem("tiksee.arInView") === "1");
    const [gizmoSel, setGizmoSel] = useState<SceneSel>(selected ? { kind: "ar", id: selected } : null);
    /** In 3D mode the panel folds to its header so the whole picture is free to edit. */
    const [folded, setFolded] = useState(false);
    const compact = inView && folded;
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ id: string; startX: number; startY: number; ox: number; oy: number; rot: number; rotate: boolean } | null>(null);
    const pendingRef = useRef<ArObject[] | null>(null);
    const rafRef = useRef(0);
    const objectsRef = useRef(objects);
    useEffect(() => {
        objectsRef.current = objects;
    }, [objects]);
    useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

    const sel = objects.find((o) => o.id === selected) ?? null;

    /** Coalesce pointer-rate edits to one apply per frame. */
    const commit = (list: ArObject[]) => {
        pendingRef.current = list;
        objectsRef.current = list;
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            const next = pendingRef.current;
            pendingRef.current = null;
            if (next) patchStudio({ arObjects: next });
        });
    };
    const update = (id: string, p: Partial<ArObject>) => commit(objectsRef.current.map((o) => (o.id === id ? { ...o, ...p } : o)));

    const add = (draft: Draft) => {
        if (objects.length >= 32) {
            toast.error(t("studio.ar.full"));
            return;
        }
        const id = newId();
        commit([...objectsRef.current, { id, ...draft }]);
        setSelected(id);
        setPicker(false);
    };
    const base = (name: string): Omit<Draft, "kind" | "content"> => ({ name, visible: true, x: 0.5, y: 0.45, z: 1.5, size: 0.3, rotation: 0, yaw: 0, animate: "bob", anchor: "world" });

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            const content = await imageToDataUrl(file);
            add({ ...base(file.name.slice(0, 60) || t("studio.ar.kinds.image")), kind: "image", content });
        } catch (e) {
            toast.error(t("studio.ar.imageFailed", { error: String(e) }));
        }
    };

    const remove = (id: string) => {
        commit(objectsRef.current.filter((o) => o.id !== id));
        if (selected === id) setSelected(null);
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        const box = e.currentTarget.parentElement?.getBoundingClientRect();
        if (!box) return;
        const [nx, ny] = toNormalised(rect, e.clientX - box.left, e.clientY - box.top);
        const hit = controller.pickArObject(nx, ny);
        const id = hit ?? selected;
        if (hit) setSelected(hit);
        const o = objectsRef.current.find((x) => x.id === id);
        if (!o) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: o.id, startX: e.clientX, startY: e.clientY, ox: o.x, oy: o.y, rot: o.rotation, rotate: e.shiftKey };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || rect.width <= 0) return;
        const dx = (e.clientX - d.startX) / rect.width;
        const dy = (e.clientY - d.startY) / rect.height;
        if (d.rotate) update(d.id, { rotation: clamp(Math.round(d.rot + (e.clientX - d.startX) * 0.5), -180, 180) });
        else update(d.id, { x: clamp(d.ox + dx, -0.5, 1.5), y: clamp(d.oy + dy, -0.5, 1.5) });
    };
    const endDrag = () => {
        drag.current = null;
    };

    useEffect(() => {
        // Non-passive wheel so the page never scrolls; attached natively.
        const layer = document.getElementById("ar-capture");
        if (!layer) return;
        const onWheel = (e: WheelEvent) => {
            const id = selected;
            const o = objectsRef.current.find((x) => x.id === id);
            if (!o) return;
            e.preventDefault();
            const notches = -Math.sign(e.deltaY);
            if (e.altKey) update(o.id, { size: clamp(Math.round(o.size * (1 + notches * 0.08) * 1000) / 1000, 0.02, 3) });
            else update(o.id, { z: stepDepth(o.z, notches) });
        };
        layer.addEventListener("wheel", onWheel, { passive: false });
        return () => layer.removeEventListener("wheel", onWheel);
    });

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
        }
        if (!sel) return;
        const step = e.shiftKey ? 0.05 : 0.01;
        const map: Record<string, Partial<ArObject> | undefined> = {
            ArrowLeft: { x: clamp(sel.x - step, -0.5, 1.5) },
            ArrowRight: { x: clamp(sel.x + step, -0.5, 1.5) },
            ArrowUp: { y: clamp(sel.y - step, -0.5, 1.5) },
            ArrowDown: { y: clamp(sel.y + step, -0.5, 1.5) },
            PageUp: { z: stepDepth(sel.z, 1) },
            PageDown: { z: stepDepth(sel.z, -1) },
            "+": { size: clamp(sel.size * 1.08, 0.02, 3) },
            "=": { size: clamp(sel.size * 1.08, 0.02, 3) },
            "-": { size: clamp(sel.size / 1.08, 0.02, 3) },
        };
        const p = map[e.key];
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        update(sel.id, p);
    };

    return (
        <>
            {inView ? (
                <Suspense fallback={null}>
                    <SceneGizmo
                        sel={gizmoSel}
                        onSel={(s) => {
                            setGizmoSel(s);
                            if (s?.kind === "ar") setSelected(s.id);
                        }}
                    />
                </Suspense>
            ) : (
            /* Capture layer exactly over the displayed image. */
            <div
                id="ar-capture"
                tabIndex={0}
                role="application"
                aria-label={t("studio.ar.canvasLabel")}
                aria-describedby="ar-help"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onKey}
                className={`absolute cursor-crosshair rounded-sm ring-1 ring-inset ring-amber-300/40 ${FOCUS_RING}`}
                style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
            )}
            {!inView && sel && rect.width > 0 && (
                <motion.div
                    className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-300 shadow-[0_0_16px_rgb(252_211_77/0.7)]"
                    animate={{ left: rect.left + sel.x * rect.width, top: rect.top + sel.y * rect.height }}
                    transition={reduced ? INSTANT : { type: "spring", bounce: 0, visualDuration: 0.12 }}
                    style={{ width: 28, height: 28 }}
                    aria-hidden
                />
            )}

            {!inView && (
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
                    <DepthRuler objects={objects} selected={selected} onSelect={setSelected} onDepth={(id, z) => update(id, { z })} />
                </div>
            )}

            <motion.aside
                aria-label={t("studio.ar.title")}
                initial={reduced ? false : { opacity: 0, x: 32 }}
                animate={{ opacity: 1, x: 0, height: compact ? 52 : "auto" }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, x: 32 }}
                transition={reduced ? INSTANT : SPRING}
                onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                }}
                className={`${GLASS} pointer-events-auto absolute right-3 top-16 flex w-[min(20rem,calc(100cqw-1.5rem))] flex-col overflow-hidden rounded-3xl ${compact ? "" : "bottom-3"}`}
            >
                <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <h2 className="text-sm font-semibold">{t("studio.ar.title")}</h2>
                    <div className="flex items-center gap-1">
                        {inView && (
                            <button
                                type="button"
                                onClick={() => setFolded((v) => !v)}
                                aria-expanded={!folded}
                                aria-label={t(folded ? "studio.ar.gizmo.expand" : "studio.ar.gizmo.fold")}
                                className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}
                            >
                                {folded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronUp className="size-4" aria-hidden />}
                            </button>
                        )}
                        <button type="button" onClick={onClose} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}>
                            <X className="size-4" aria-hidden />
                        </button>
                    </div>
                </header>
                <div className={`flex-1 space-y-4 overflow-y-auto px-4 py-3 ${compact ? "hidden" : ""}`}>
                    <SwitchRow
                        label={t("studio.ar.gizmo.toggle")}
                        description={t("studio.ar.gizmo.toggleHint")}
                        checked={inView}
                        onChange={(on) => {
                            setInView(on);
                            sessionStorage.setItem("tiksee.arInView", on ? "1" : "0");
                            if (on && selected) setGizmoSel({ kind: "ar", id: selected });
                            // Turning it on folds the panel so the picture is free; the chevron reopens it.
                            setFolded(on);
                        }}
                    />
                    <div className="grid grid-cols-4 gap-1.5">
                        <AddButton icon={<Smile className="size-4" aria-hidden />} label={t("studio.ar.kinds.emoji")} onClick={() => setPicker((v) => !v)} pressed={picker} />
                        <AddButton
                            icon={<Type className="size-4" aria-hidden />}
                            label={t("studio.ar.kinds.text")}
                            onClick={() => {
                                const value = text.trim();
                                if (value) add({ ...base(value.slice(0, 60)), kind: "text", content: value.slice(0, 200) });
                                else document.getElementById("ar-text")?.focus();
                            }}
                        />
                        <AddButton icon={<ImagePlus className="size-4" aria-hidden />} label={t("studio.ar.kinds.image")} onClick={() => fileRef.current?.click()} />
                        <AddButton
                            icon={<PawPrint className="size-4" aria-hidden />}
                            label={t("studio.ar.kinds.model")}
                            onClick={() => add({ ...base(t(`studio.pets.${PETS[0] ?? "parrot"}`)), kind: "model", content: PETS[0] ?? "parrot", animate: "none" })}
                        />
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
                    <label className="block text-[0.6875rem] text-white/75">
                        {t("studio.ar.textLabel")}
                        <input
                            id="ar-text"
                            value={text}
                            maxLength={200}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && text.trim()) add({ ...base(text.trim().slice(0, 60)), kind: "text", content: text.trim() });
                            }}
                            className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-white/50 focus:border-sky-300"
                            placeholder={t("studio.ar.textPlaceholder")}
                        />
                    </label>
                    <AnimatePresence>
                        {picker && (
                            <motion.div
                                role="listbox"
                                aria-label={t("studio.ar.emojiPicker")}
                                initial={reduced ? false : { opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={reduced ? INSTANT : SPRING}
                                className="grid grid-cols-8 gap-1 overflow-hidden"
                            >
                                {EMOJIS.map((e) => (
                                    <button
                                        key={e}
                                        type="button"
                                        role="option"
                                        aria-selected={false}
                                        aria-label={e}
                                        onClick={() => add({ ...base(e), kind: "emoji", content: e })}
                                        className={`grid aspect-square place-items-center rounded-lg text-lg hover:bg-white/15 ${FOCUS_RING}`}
                                    >
                                        {e}
                                    </button>
                                ))}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <section aria-label={t("studio.ar.list")}>
                        <h3 className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-white/70">{t("studio.ar.list")}</h3>
                        {objects.length === 0 ? (
                            <p className="text-xs text-white/70">{t("studio.ar.empty")}</p>
                        ) : (
                            <ul className="space-y-1">
                                {objects.map((o) => (
                                    <li key={o.id} className={`flex items-center gap-1 rounded-xl ${o.id === selected ? "bg-sky-400/20 ring-1 ring-sky-300/50" : ""}`}>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelected(o.id);
                                                setGizmoSel({ kind: "ar", id: o.id });
                                            }}
                                            aria-pressed={o.id === selected}
                                            className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs ${FOCUS_RING}`}
                                        >
                                            <ObjectGlyph o={o} />
                                            <span className="truncate">{o.name}</span>
                                            <span className="ml-auto tabular-nums text-white/70">{o.z.toFixed(2)} m</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => update(o.id, { visible: !o.visible })}
                                            aria-label={t(o.visible ? "studio.ar.hide" : "studio.ar.show", { name: o.name })}
                                            className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}
                                        >
                                            {o.visible ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5 text-white/60" aria-hidden />}
                                        </button>
                                        <button type="button" onClick={() => remove(o.id)} aria-label={t("studio.ar.delete", { name: o.name })} className={`grid size-7 place-items-center rounded-full hover:bg-rose-500/30 ${FOCUS_RING}`}>
                                            <Trash2 className="size-3.5" aria-hidden />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {sel && <Properties key={sel.id} o={sel} onChange={(p) => update(sel.id, p)} />}
                    <p id="ar-help" className="text-[0.6875rem] leading-snug text-white/70">
                        {t("studio.ar.help")}
                    </p>
                </div>
            </motion.aside>
        </>
    );
}

function AddButton({ icon, label, onClick, pressed }: { icon: ReactNode; label: string; onClick: () => void; pressed?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
            className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[0.625rem] font-medium ${pressed ? "bg-sky-400/30" : "bg-white/10 hover:bg-white/20"} ${FOCUS_RING}`}
        >
            {icon}
            {label}
        </button>
    );
}

function Properties({ o, onChange }: { o: ArObject; onChange: (p: Partial<ArObject>) => void }) {
    const { t } = useTranslation();
    return (
        <section aria-label={t("studio.ar.properties")} className="space-y-3 border-t border-white/10 pt-3">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-white/70">{t("studio.ar.properties")}</h3>
            <label className="block text-[0.6875rem] text-white/75">
                {t("studio.ar.name")}
                <input
                    value={o.name}
                    maxLength={60}
                    onChange={(e) => {
                        if (e.target.value.trim()) onChange({ name: e.target.value });
                    }}
                    className="mt-1 w-full rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none focus:border-sky-300"
                />
            </label>
            {o.kind === "model" && (
                <label className="block text-[0.6875rem] text-white/75">
                    {t("studio.ar.model")}
                    <select
                        value={o.content}
                        onChange={(e) => onChange({ content: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-white/15 bg-neutral-900 px-2.5 py-1.5 text-sm text-white outline-none focus:border-sky-300"
                    >
                        {PETS.map((p) => (
                            <option key={p} value={p}>
                                {t(`studio.pets.${p}`)}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            <SwitchRow label={t("studio.ar.visible")} checked={o.visible} onChange={(visible) => onChange({ visible })} />
            <SliderRow label={t("studio.ar.depth")} value={depthToPos(o.z)} min={0} max={1} step={0.005} format={(v) => `${posToDepth(v).toFixed(2)} m`} onCommit={(v) => onChange({ z: posToDepth(v) })} />
            <SliderRow label={t("studio.ar.size")} value={o.size} min={0.02} max={3} step={0.01} format={(v) => `${v.toFixed(2)} m`} onCommit={(size) => onChange({ size })} />
            <SliderRow label={t("studio.ar.rotation")} value={o.rotation} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onCommit={(rotation) => onChange({ rotation: Math.round(rotation) })} />
            <SliderRow label={t("studio.ar.yaw")} value={o.yaw} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onCommit={(yaw) => onChange({ yaw: Math.round(yaw) })} />
            <Select label={t("studio.ar.animate")} value={o.animate} options={ANIMATIONS} display={(v) => t(`studio.ar.animations.${v}`)} onChange={(animate) => onChange({ animate })} />
            <Select label={t("studio.ar.anchor")} value={o.anchor} options={ANCHORS} display={(v) => t(`studio.ar.anchors.${v}`)} onChange={(anchor) => onChange({ anchor })} />
        </section>
    );
}

function Select<T extends string>({ label, value, options, display, onChange }: { label: string; value: T; options: readonly T[]; display: (v: T) => string; onChange: (v: T) => void }) {
    return (
        <label className="block text-[0.6875rem] text-white/75">
            {label}
            <select
                value={value}
                onChange={(e) => {
                    const v = options.find((o) => o === e.target.value);
                    if (v) onChange(v);
                }}
                className="mt-1 w-full rounded-lg border border-white/15 bg-neutral-900 px-2.5 py-1.5 text-sm text-white outline-none focus:border-sky-300"
            >
                {options.map((o) => (
                    <option key={o} value={o}>
                        {display(o)}
                    </option>
                ))}
            </select>
        </label>
    );
}
