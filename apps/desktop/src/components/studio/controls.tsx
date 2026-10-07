import { PET_CHOICES, type StudioSettings } from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
    Aperture,
    Box,
    Camera,
    Circle,
    Crosshair,
    Focus,
    Frame,
    Minus,
    MonitorCog,
    PawPrint,
    Plus,
    Ruler,
    ScanFace,
    Search,
    Sparkles,
    SunMedium,
    Volume2,
    X,
    ZoomIn,
    ZoomOut,
    type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useFrame, useStudio } from "./context.js";
import { ActionButton, Section } from "./controls-parts.js";
import { HoldButton } from "./hold-button.js";

const AiPanel = lazy(() => import("./ai-panel.js").then((m) => ({ default: m.AiPanel })));
const MonitorPanel = lazy(() => import("./monitor-panel.js").then((m) => ({ default: m.MonitorPanel })));
const SoundPanel = lazy(() => import("./sound-panel.js").then((m) => ({ default: m.SoundPanel })));

const PANELS = ["zoom", "focus", "look", "framing", "monitor", "camera", "pets", "ai", "sound", "ar"] as const;
export type PanelId = (typeof PANELS)[number];

const ICONS: Record<PanelId, LucideIcon> = {
    zoom: Search,
    focus: Focus,
    look: SunMedium,
    framing: Frame,
    monitor: MonitorCog,
    camera: Camera,
    pets: PawPrint,
    ai: Sparkles,
    sound: Volume2,
    ar: Box,
};

const AF_INTERVALS = ["0", "5", "10", "30", "60"] as const;
const SPEEDS = ["1", "2", "3"] as const;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

function ZoomPanel() {
    const { studio, controller, frames, patchStudio } = useStudio();
    const { t } = useTranslation();
    const connected = useFrame(frames, (i) => i?.camera.connected ?? false);
    const [speed, setSpeed] = useState<"1" | "2" | "3">("2");
    const sp = Number(speed) as 1 | 2 | 3;
    return (
        <>
            <Section title={t("studio.controls.zoom.optical")}>
                <div className="grid grid-cols-2 gap-2">
                    <HoldButton
                        label={t("studio.controls.zoom.wide")}
                        icon={<ZoomOut className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("zoomOut", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                    <HoldButton
                        label={t("studio.controls.zoom.tele")}
                        icon={<ZoomIn className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("zoomIn", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                </div>
                <ChipSelector label={t("studio.controls.speed")} options={SPEEDS} value={speed} onSelect={setSpeed} display={(v) => `${v}×`} />
                {!connected && <p className="text-[0.6875rem] text-white/70">{t("studio.controls.bleOffline")}</p>}
            </Section>
            <Section title={t("studio.controls.zoom.digital")}>
                <SliderRow
                    label={t("studio.controls.zoom.digitalLabel")}
                    value={studio.framing.zoom}
                    min={1}
                    max={2.5}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}×`}
                    onCommit={(zoom) => patchStudio({ framing: { ...studio.framing, zoom } })}
                />
            </Section>
        </>
    );
}

function FocusPanel({ onLoupe }: { onLoupe: (on: boolean) => void }) {
    const { studio, controller, frames, patchStudio } = useStudio();
    const { t } = useTranslation();
    const connected = useFrame(frames, (i) => i?.camera.connected ?? false);
    const [speed, setSpeed] = useState<"1" | "2" | "3">("1");
    const sp = Number(speed) as 1 | 2 | 3;
    return (
        <>
            <Section title={t("studio.controls.focus.auto")}>
                <ActionButton icon={<ScanFace className="size-4" aria-hidden />} label={t("studio.controls.focus.af")} onClick={() => void controller.run({ type: "camera", action: "af" })} />
                <ChipSelector
                    label={t("studio.controls.focus.interval")}
                    options={AF_INTERVALS}
                    value={String(studio.framing.afIntervalS) as (typeof AF_INTERVALS)[number]}
                    onSelect={(v) => patchStudio({ framing: { ...studio.framing, afIntervalS: Number(v) } })}
                    display={(v) => (v === "0" ? t("studio.common.off") : t("studio.controls.focus.everyS", { s: v }))}
                />
            </Section>
            <Section title={t("studio.controls.focus.manual")}>
                <div className="grid grid-cols-2 gap-2">
                    <HoldButton
                        label={t("studio.controls.focus.near")}
                        icon={<Minus className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("focusNear", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                    <HoldButton
                        label={t("studio.controls.focus.far")}
                        icon={<Plus className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("focusFar", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                </div>
                <ChipSelector label={t("studio.controls.speed")} options={SPEEDS} value={speed} onSelect={setSpeed} display={(v) => `${v}×`} />
                <HoldButton
                    label={t("studio.controls.focus.loupe", { zoom: studio.monitor.loupeZoom })}
                    icon={<Crosshair className="size-4" aria-hidden />}
                    onStart={() => onLoupe(true)}
                    onStop={() => onLoupe(false)}
                    className="w-full"
                />
            </Section>
        </>
    );
}

function LookPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    return (
        <Section title={t("studio.controls.look.title")}>
            <SliderRow label={t("studio.controls.look.exposure")} value={studio.exposure} min={-2} max={2} step={0.1} format={(v) => `${signed(v)} EV`} onCommit={(exposure) => patchStudio({ exposure })} />
            <SliderRow label={t("studio.controls.look.warmth")} value={studio.warmth} min={-1} max={1} step={0.05} format={(v) => signed(v, 2)} onCommit={(warmth) => patchStudio({ warmth })} />
            <SliderRow label={t("studio.controls.look.smoothing")} value={studio.smoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(smoothing) => patchStudio({ smoothing })} />
            <SliderRow label={t("studio.controls.look.blur")} value={studio.backgroundBlur} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(backgroundBlur) => patchStudio({ backgroundBlur })} />
        </Section>
    );
}
function FramingPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const f = studio.framing;
    const set = (p: Partial<StudioSettings["framing"]>) => patchStudio({ framing: { ...f, ...p } });
    return (
        <>
            <Section title={t("studio.controls.framing.reframe")}>
                <SwitchRow label={t("studio.controls.framing.auto")} description={t("studio.controls.framing.autoHint")} checked={f.autoReframe} onChange={(autoReframe) => set({ autoReframe })} />
                <SwitchRow label={t("studio.controls.framing.smartWide")} checked={f.smartWide} onChange={(smartWide) => set({ smartWide })} />
                <SliderRow label={t("studio.controls.framing.deadZone")} value={f.deadZone} min={0} max={0.3} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(deadZone) => set({ deadZone })} disabled={!f.autoReframe} />
            </Section>
            <Section title={t("studio.controls.framing.dof")}>
                <SwitchRow label={t("studio.controls.framing.dofOn")} checked={f.dof} onChange={(dof) => set({ dof })} />
                <SliderRow label={t("studio.controls.framing.dofStrength")} value={f.dofStrength} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(dofStrength) => set({ dofStrength })} disabled={!f.dof} />
            </Section>
        </>
    );
}

function CameraPanel({ onSpace }: { onSpace: () => void }) {
    const { controller, frames, studio } = useStudio();
    const { t } = useTranslation();
    const recording = useFrame(frames, (i) => i?.camera.recording ?? false);
    const [counting, setCounting] = useState(false);
    const photo = async () => {
        if (counting) return;
        setCounting(true);
        try {
            await controller.run({ type: "effect", effect: "countdown" });
            await sleep(3000);
            await controller.run({ type: "camera", action: "photo" });
        } finally {
            setCounting(false);
        }
    };
    return (
        <Section title={t("studio.controls.camera.title")}>
            <div className="grid grid-cols-2 gap-2">
                <ActionButton icon={<Aperture className="size-4" aria-hidden />} label={counting ? t("studio.controls.camera.counting") : t("studio.controls.camera.photo")} onClick={() => void photo()} />
                <ActionButton
                    icon={<Circle className={`size-4 ${recording ? "fill-white" : "fill-red-500 text-red-500"}`} aria-hidden />}
                    label={recording ? t("studio.controls.camera.stop") : t("studio.controls.camera.record")}
                    active={recording}
                    onClick={() => void controller.run({ type: "camera", action: "record" })}
                />
            </div>
            <p className="text-[0.6875rem] text-white/70">{t("studio.controls.camera.hint")}</p>
            <ActionButton icon={<Ruler className="size-4" aria-hidden />} label={t("studio.space.open")} onClick={onSpace} />
            <p className="text-[0.6875rem] text-white/70">
                {studio.space.calibratedAt > 0 ? t("studio.space.calibratedShort", { vfov: Math.round(studio.vfovDeg) }) : t("studio.space.notCalibrated")}
            </p>
        </Section>
    );
}

function PetsPanel() {
    const { studio, petsHidden, patchStudio } = useStudio();
    const { t } = useTranslation();
    return (
        <Section title={t("studio.controls.pets.title")}>
            <ChipSelector label={t("studio.controls.pets.left")} options={PET_CHOICES} value={studio.leftPet} onSelect={(leftPet) => patchStudio({ leftPet })} display={(v) => t(`studio.pets.${v}`)} />
            <ChipSelector label={t("studio.controls.pets.right")} options={PET_CHOICES} value={studio.rightPet} onSelect={(rightPet) => patchStudio({ rightPet })} display={(v) => t(`studio.pets.${v}`)} />
            <SwitchRow
                label={t("studio.controls.pets.hide")}
                checked={petsHidden}
                onChange={(hide) => sidecarClient.send({ type: "control", action: hide ? "petsHide" : "petsShow" })}
            />
        </Section>
    );
}

/* ------------------------------------------------------------------ *
 * Pill values
 * ------------------------------------------------------------------ */

function usePillValue(id: PanelId): string {
    const { studio, petsHidden, frames } = useStudio();
    const { t } = useTranslation();
    const focused = useFrame(frames, (i) => i?.camera.focused ?? false);
    const recording = useFrame(frames, (i) => i?.camera.recording ?? false);
    const m = studio.monitor;
    switch (id) {
        case "zoom":
            return `${studio.framing.zoom.toFixed(1)}×`;
        case "focus":
            return focused ? t("studio.controls.focus.locked") : studio.framing.afIntervalS > 0 ? "AF-C" : "AF";
        case "look":
            return `${signed(studio.exposure)} EV`;
        case "framing":
            return studio.framing.autoReframe ? t("studio.controls.framing.autoShort") : studio.framing.dof ? "DoF" : t("studio.common.off");
        case "monitor": {
            if (m.cleanFeed) return t("studio.controls.monitor.clean");
            const n = [m.peaking, m.zebra, m.falseColor, m.clipping, m.scope !== "none", m.guides !== "none", m.safeZones, m.debug3d, m.micPanel, m.transcript].filter(Boolean).length;
            return t("studio.controls.monitor.aids", { count: n });
        }
        case "camera":
            return recording ? "REC" : t("studio.controls.camera.ready");
        case "pets":
            return petsHidden ? t("studio.controls.pets.hidden") : [studio.leftPet, studio.rightPet].filter((p) => p !== "none").length.toString();
        case "ai":
            return t(`studio.controls.ai.levels.${studio.petAi.level}`);
        case "sound":
            return studio.petAi.voice ? t("studio.controls.sound.pets") : t("studio.controls.sound.cohost");
        case "ar":
            return String(studio.arObjects.length);
    }
}

function Pill({ id, onOpen }: { id: PanelId; onOpen: (id: PanelId) => void }) {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const value = usePillValue(id);
    const Icon = ICONS[id];
    const label = t(`studio.controls.${id}.name`);
    return (
        <motion.button
            type="button"
            layoutId={`pill-${id}`}
            transition={reduced ? INSTANT : SPRING}
            onClick={() => onOpen(id)}
            aria-label={`${label}: ${value}`}
            title={label}
            aria-haspopup="dialog"
            data-pill={id}
            className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-white hover:bg-white/15 @[34rem]/studio:flex-none @[34rem]/studio:min-w-16 @[34rem]/studio:px-3 ${FOCUS_RING}`}
            style={{ borderRadius: 16 }}
        >
            <motion.span layout="position" className="flex min-w-0 max-w-full items-center justify-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-white/75">
                <Icon className="size-3.5 shrink-0 @[34rem]/studio:size-3" aria-hidden />
                {/* Narrow windows show icon + value only: a clipped "FOC…" label reads worse than none. */}
                <span className="hidden truncate @[34rem]/studio:inline">{label}</span>
            </motion.span>
            <motion.span layout="position" className="max-w-full truncate text-xs font-bold tabular-nums @[34rem]/studio:text-sm">
                {value}
            </motion.span>
        </motion.button>
    );
}

function Panel({ id, onClose, onLoupe, onSpace }: { id: PanelId; onClose: () => void; onLoupe: (on: boolean) => void; onSpace: () => void }) {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const ref = useRef<HTMLDivElement>(null);
    const Icon = ICONS[id];

    useEffect(() => {
        const first = ref.current?.querySelector<HTMLElement>("button, [role=slider], input, [role=switch]");
        first?.focus({ preventScroll: true });
    }, []);

    return (
        <motion.div
            ref={ref}
            layoutId={`pill-${id}`}
            transition={reduced ? INSTANT : SPRING}
            role="dialog"
            aria-label={t(`studio.controls.${id}.name`)}
            data-panel={id}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    onClose();
                }
            }}
            className={`${GLASS} pointer-events-auto absolute bottom-full left-1/2 mb-3 w-[min(22rem,calc(100cqw-1.5rem))] -translate-x-1/2 overflow-hidden`}
            style={{ borderRadius: 24 }}
        >
            <motion.div layout="position" className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="size-4 text-sky-300" aria-hidden />
                    {t(`studio.controls.${id}.name`)}
                </h2>
                <button type="button" onClick={onClose} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 ${FOCUS_RING}`}>
                    <X className="size-4" aria-hidden />
                </button>
            </motion.div>
            <motion.div
                className="max-h-[min(60cqh,32rem)] space-y-3 overflow-y-auto px-4 py-3"
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: reduced ? 0 : 0.08 } }}
                exit={{ opacity: 0, transition: { duration: 0.05 } }}
            >
                {id === "zoom" && <ZoomPanel />}
                {id === "focus" && <FocusPanel onLoupe={onLoupe} />}
                {id === "look" && <LookPanel />}
                {id === "framing" && <FramingPanel />}
                {id === "monitor" && (
                    <Suspense fallback={<div className="h-40" aria-busy />}>
                        <MonitorPanel />
                    </Suspense>
                )}
                {id === "camera" && <CameraPanel onSpace={onSpace} />}
                {id === "pets" && <PetsPanel />}
                {id === "ai" && (
                    <Suspense fallback={<div className="h-40" aria-busy />}>
                        <AiPanel />
                    </Suspense>
                )}
                {id === "sound" && (
                    <Suspense fallback={<div className="h-40" aria-busy />}>
                        <SoundPanel />
                    </Suspense>
                )}
            </motion.div>
        </motion.div>
    );
}

/** iOS / Blackmagic-camera style bottom dock: value pills that morph into their panel. */
export function ControlDock({
    open,
    onOpenChange,
    onAr,
    onLoupe,
    onSpace,
}: {
    open: PanelId | null;
    onOpenChange: (id: PanelId | null) => void;
    onAr: () => void;
    onLoupe: (on: boolean) => void;
    /** Open the 3D space calibration wizard. */
    onSpace: () => void;
}) {
    const { t } = useTranslation();
    const dock = useRef<HTMLDivElement>(null);
    const lastOpen = useRef<PanelId | null>(null);

    useEffect(() => {
        if (open) {
            lastOpen.current = open;
            return;
        }
        // Return focus to the pill the panel came from.
        const id = lastOpen.current;
        if (!id) return;
        lastOpen.current = null;
        const raf = requestAnimationFrame(() => dock.current?.querySelector<HTMLElement>(`[data-pill="${id}"]`)?.focus({ preventScroll: true }));
        return () => cancelAnimationFrame(raf);
    }, [open]);

    const choose = (id: PanelId) => {
        if (id === "ar") {
            onOpenChange(null);
            onAr();
        } else onOpenChange(open === id ? null : id);
    };

    return (
        <LayoutGroup id="studio-dock">
            <div ref={dock} className="relative w-full @[34rem]/studio:w-auto">
                <AnimatePresence>{open && <Panel key={open} id={open} onClose={() => onOpenChange(null)} onLoupe={onLoupe} onSpace={onSpace} />}</AnimatePresence>
                <nav
                    aria-label={t("studio.controls.label")}
                    // One row that scales with the window (pills flex, text uses container units);
                    // only below ~18rem does it wrap. Never cut off.
                    className={`${GLASS} flex w-full flex-wrap items-center justify-center gap-0.5 rounded-[1.375rem] p-1 @[18rem]/studio:flex-nowrap @[34rem]/studio:w-auto`}
                >
                    {PANELS.map((id) =>
                        open === id ? (
                            <span key={id} className="invisible flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-1.5 @[34rem]/studio:flex-none @[34rem]/studio:min-w-16 @[34rem]/studio:px-3" aria-hidden>
                                <span className="text-[0.625rem]">{t(`studio.controls.${id}.name`)}</span>
                                <span className="text-sm">·</span>
                            </span>
                        ) : (
                            <Pill key={id} id={id} onOpen={choose} />
                        ),
                    )}
                </nav>
            </div>
        </LayoutGroup>
    );
}
