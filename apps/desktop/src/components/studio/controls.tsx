import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Box, Camera, Focus, Frame, Hand, MonitorCog, PawPrint, Search, Sparkles, SunMedium, Volume2, X, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { FOCUS_RING, GLASS, INSTANT, SPRING, useFrame, useStudio } from "./context.js";

const AiPanel = lazy(() => import("./ai-panel.js").then((m) => ({ default: m.AiPanel })));
const MonitorPanel = lazy(() => import("./monitor-panel.js").then((m) => ({ default: m.MonitorPanel })));
const SoundPanel = lazy(() => import("./sound-panel.js").then((m) => ({ default: m.SoundPanel })));
const GesturesPanel = lazy(() => import("./gestures-panel.js").then((m) => ({ default: m.GesturesPanel })));
// Simple panels share one lazy chunk (they used to sit in the studio entry chunk).
const dock = () => import("./dock-panels.js");
const ZoomPanel = lazy(() => dock().then((m) => ({ default: m.ZoomPanel })));
const FocusPanel = lazy(() => dock().then((m) => ({ default: m.FocusPanel })));
const LookPanel = lazy(() => dock().then((m) => ({ default: m.LookPanel })));
const FramingPanel = lazy(() => dock().then((m) => ({ default: m.FramingPanel })));
const CameraPanel = lazy(() => dock().then((m) => ({ default: m.CameraPanel })));
const PetsPanel = lazy(() => dock().then((m) => ({ default: m.PetsPanel })));

const PANELS = ["zoom", "focus", "look", "framing", "monitor", "camera", "pets", "ai", "gestures", "sound", "ar"] as const;
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
    gestures: Hand,
    sound: Volume2,
    ar: Box,
};

const signed = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;

/* ------------------------------------------------------------------ *
 * Pill values
 * ------------------------------------------------------------------ */

function usePillValue(id: PanelId): string {
    const { studio, vision, petsHidden, frames } = useStudio();
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
        case "gestures":
            return vision.rulesEnabled ? String(vision.rules.filter((r) => r.enabled).length) : t("studio.common.off");
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
            className={`flex min-w-0 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-white hover:bg-white/15 ${FOCUS_RING}`}
            style={{ borderRadius: 16 }}
        >
            <motion.span layout="position" className="flex min-w-0 max-w-full items-center justify-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-white/75">
                <Icon className="size-3.5 shrink-0 @[34rem]/studio:size-3" aria-hidden />
                {/* Very narrow windows show icon + value only: a clipped "FOC…" label reads worse than none. */}
                <span className="hidden truncate @[24rem]/studio:inline">{label}</span>
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
                <Suspense fallback={<div className="h-40" aria-busy />}>{panelBody(id, onLoupe, onSpace)}</Suspense>
            </motion.div>
        </motion.div>
    );
}

function panelBody(id: PanelId, onLoupe: (on: boolean) => void, onSpace: () => void): ReactNode {
    switch (id) {
        case "zoom":
            return <ZoomPanel />;
        case "focus":
            return <FocusPanel onLoupe={onLoupe} />;
        case "look":
            return <LookPanel />;
        case "framing":
            return <FramingPanel />;
        case "monitor":
            return <MonitorPanel />;
        case "camera":
            return <CameraPanel onSpace={onSpace} />;
        case "pets":
            return <PetsPanel />;
        case "ai":
            return <AiPanel />;
        case "sound":
            return <SoundPanel />;
        case "gestures":
            return <GesturesPanel />;
        case "ar":
            return null;
    }
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
            <div ref={dock} className="relative w-full @[52rem]/studio:w-auto">
                <AnimatePresence>{open && <Panel key={open} id={open} onClose={() => onOpenChange(null)} onLoupe={onLoupe} onSpace={onSpace} />}</AnimatePresence>
                <nav
                    aria-label={t("studio.controls.label")}
                    // Two even rows (6 + 5) on narrow and portrait windows, one row from 52rem wide:
                    // a grid, so every pill keeps a fair share of the width and nothing is cut off.
                    className={`${GLASS} grid w-full grid-cols-6 items-stretch gap-0.5 rounded-[1.375rem] p-1 @[52rem]/studio:w-auto @[52rem]/studio:grid-flow-col @[52rem]/studio:grid-cols-none @[52rem]/studio:auto-cols-[minmax(4.25rem,auto)]`}
                >
                    {PANELS.map((id) =>
                        open === id ? (
                            <span key={id} className="invisible flex min-w-0 flex-col items-center gap-0.5 px-1 py-1.5" aria-hidden>
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
