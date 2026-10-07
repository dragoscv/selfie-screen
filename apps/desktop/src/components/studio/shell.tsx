import type { AudioSettings, IdentityProfile, StudioSettings, VisionSettings, VoiceSettings } from "@tiksee/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

import type { StudioController } from "../../lib/studio/controller.js";
import { radialToAction, type EnrolRequest, type RadialAction } from "./actions.js";
import { AfBoxes } from "./af-boxes.js";
import { Coach } from "./coach.js";
import { INSTANT, SPRING, StudioContext, type FrameStore, type StudioContextValue } from "./context.js";
import { ControlDock, type PanelId } from "./controls.js";
import { containRect, sameRect, type Rect } from "./geometry.js";
import { GestureHud } from "./gesture-hud.js";
import { Guides } from "./guides.js";
import { Loupe } from "./loupe.js";
import { RadialMenu } from "./radial-menu.js";
import { ScopesDock } from "./scopes.js";
import { StatusBar } from "./status.js";

// On-demand flows stay out of the studio entry chunk (budget: scripts/check-budgets.mjs).
const ArEditor = lazy(() => import("./ar-editor.js").then((m) => ({ default: m.ArEditor })));
const Calibration = lazy(() => import("./calibration.js").then((m) => ({ default: m.Calibration })));
const Captions = lazy(() => import("./captions.js").then((m) => ({ default: m.Captions })));
const CaptionEditor = lazy(() => import("./caption-editor.js").then((m) => ({ default: m.CaptionEditor })));
const Debug3d = lazy(() => import("./debug3d.js").then((m) => ({ default: m.Debug3d })));
const Enrol = lazy(() => import("./enrol.js").then((m) => ({ default: m.Enrol })));
const SpaceCalibration = lazy(() => import("./space-calibration.js").then((m) => ({ default: m.SpaceCalibration })));
const Tutorial = lazy(() => import("./tutorial.js").then((m) => ({ default: m.Tutorial })));

const IDLE_MS = 3000;
const EMPTY_RECT: Rect = { left: 0, top: 0, width: 0, height: 0 };

export type StudioModal = { kind: "tutorial" } | { kind: "calibrate" } | { kind: "space" } | { kind: "enrol"; request: EnrolRequest } | null;

export interface StudioShellProps {
    controller: StudioController;
    canvas: HTMLCanvasElement;
    frames: FrameStore;
    studio: StudioSettings;
    vision: VisionSettings;
    profiles: readonly IdentityProfile[];
    petsHidden: boolean;
    modal: StudioModal;
    onModal: (modal: StudioModal) => void;
    /** Loupe forced on by an engine action (`loupeToggle`). */
    loupe: boolean;
    patchStudio(patch: Partial<StudioSettings>): void;
    patchVision(patch: Partial<VisionSettings>): void;
    patchSound(patch: { voice?: Partial<VoiceSettings>; audio?: Partial<AudioSettings> }): void;
}

/** Tracks where the `object-fit: contain` canvas image lands inside the shell. */
function useDisplayedRect(shell: HTMLElement | null, canvas: HTMLCanvasElement, frames: FrameStore) {
    const [rect, setRect] = useState<Rect>(EMPTY_RECT);
    const rectRef = useRef<Rect>(EMPTY_RECT);

    useEffect(() => {
        if (!shell) return;
        const measure = () => {
            const next = containRect(shell.clientWidth, shell.clientHeight, canvas.width, canvas.height);
            if (sameRect(next, rectRef.current)) return;
            rectRef.current = next;
            setRect(next);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(shell);
        ro.observe(canvas);
        // The output size (canvas attributes) can change without an element resize.
        const off = frames.subscribe(measure);
        return () => {
            ro.disconnect();
            off();
        };
    }, [shell, canvas, frames]);

    return { rect, rectRef };
}

/**
 * The pro-camera control surface over the preview canvas. Nothing here is in
 * the output frame: the engine renders the output separately.
 */
export function StudioShell(props: StudioShellProps) {
    const { controller, canvas, frames, studio, vision, profiles, petsHidden, modal, onModal, loupe, patchStudio, patchVision, patchSound } = props;
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const [shell, setShell] = useState<HTMLDivElement | null>(null);
    const { rect, rectRef } = useDisplayedRect(shell, canvas, frames);
    const [panel, setPanel] = useState<PanelId | null>(null);
    const [arOpen, setArOpen] = useState(false);
    const [loupeHeld, setLoupeHeld] = useState(false);
    const [radial, setRadial] = useState<{ x: number; y: number } | null>(null);
    const [active, setActive] = useState(true);
    const [userHidden, setUserHidden] = useState(false);
    const [editing, setEditing] = useState(false);
    const idleTimer = useRef(0);
    // Latest settings for the window keydown handler (F3) without re-binding it on every patch.
    const latest = useRef({ studio, patchStudio });
    useEffect(() => {
        latest.current = { studio, patchStudio };
    }, [studio, patchStudio]);

    const poke = useCallback(() => {
        setActive(true);
        window.clearTimeout(idleTimer.current);
        idleTimer.current = window.setTimeout(() => setActive(false), IDLE_MS);
    }, []);

    useEffect(() => {
        idleTimer.current = window.setTimeout(() => setActive(false), IDLE_MS);
        return () => window.clearTimeout(idleTimer.current);
    }, []);

    const openRadial = useCallback((x: number, y: number) => {
        setPanel(null);
        setRadial({ x, y });
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            poke();
            const target = e.target as HTMLElement | null;
            const typing = target?.closest("input, textarea, select, [contenteditable]") !== null && target !== null;
            if (typing) return;
            if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.altKey && !e.metaKey) {
                setUserHidden((v) => !v);
            } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                const r = rectRef.current;
                openRadial(r.left + r.width / 2, r.top + r.height / 2);
            } else if (e.key === "Escape") {
                setPanel(null);
                setRadial(null);
            } else if (e.key === "F3" && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                const { studio: s, patchStudio: patch } = latest.current;
                patch({ monitor: { ...s.monitor, debug3d: !s.monitor.debug3d } });
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [poke, openRadial, rectRef]);

    const ctx = useMemo<StudioContextValue>(
        () => ({ controller, frames, studio, vision, profiles, petsHidden, rect, rectRef, canvas, patchStudio, patchVision, patchSound, setEditing }),
        [controller, frames, studio, vision, profiles, petsHidden, rect, rectRef, canvas, patchStudio, patchVision, patchSound],
    );

    const photo = useCallback(async () => {
        await controller.run({ type: "effect", effect: "countdown" });
        await new Promise((r) => window.setTimeout(r, 3000));
        await controller.run({ type: "camera", action: "photo" });
    }, [controller]);

    const pick = (id: RadialAction) => {
        setRadial(null);
        if (id === "photo") void photo();
        else if (id === "arAdd") setArOpen(true);
        else {
            const action = radialToAction(id);
            if (action) void controller.run(action);
        }
    };

    const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("[data-studio-ui]")) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        openRadial(e.clientX - box.left, e.clientY - box.top);
    };

    const clean = studio.monitor.cleanFeed;
    const blocking = modal !== null || arOpen;
    const controlsShown = !userHidden && (active || editing || panel !== null || radial !== null || arOpen);
    const fade = reduced ? INSTANT : SPRING;

    return (
        <StudioContext.Provider value={ctx}>
            <div
                ref={setShell}
                // Named container: every chrome element sizes against the WINDOW, not the viewport guess.
                className="@container/studio absolute inset-0 overflow-hidden text-white"
                // Shared @tiksee/ui controls over video: translucent white surfaces instead of opaque panels.
                style={
                    {
                        cursor: controlsShown ? "default" : "none",
                        "--panel-alt": "rgb(255 255 255 / 0.1)",
                        "--fg": "rgb(255 255 255)",
                        "--fg-muted": "rgb(255 255 255 / 0.78)",
                    } as CSSProperties
                }
                onPointerMove={poke}
                onPointerDown={poke}
                onContextMenu={onContextMenu}
            >
                <AnimatePresence>
                    {!clean && (
                        <motion.div
                            key="overlays"
                            className="pointer-events-none absolute inset-0"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={reduced ? INSTANT : { duration: 0.35, ease: "easeInOut" }}
                        >
                            <Guides />
                            {studio.monitor.afBox && <AfBoxes />}
                            {studio.monitor.debug3d && (
                                <Suspense fallback={null}>
                                    <Debug3d />
                                </Suspense>
                            )}
                            <GestureHud />
                            <Coach />
                        </motion.div>
                    )}
                </AnimatePresence>
                <AnimatePresence>{(loupe || loupeHeld) && <Loupe key="loupe" />}</AnimatePresence>

                {/* Caption lane (preview only): bottom centre, lifted above the dock while it shows; hidden behind an open panel or modal. */}
                {studio.monitor.transcript && !studio.captions.output && !clean && !blocking && panel === null && (
                    <motion.div
                        className="pointer-events-none absolute inset-x-3 flex justify-center"
                        initial={false}
                        animate={{ bottom: controlsShown ? 96 : 16 }}
                        transition={fade}
                    >
                        <Suspense fallback={null}>
                            <Captions />
                        </Suspense>
                    </motion.div>
                )}
                {/* On the live: the caption is in the video itself; move/resize handles while the controls show. */}
                {studio.monitor.transcript && studio.captions.output && controlsShown && !blocking && (
                    <Suspense fallback={null}>
                        <CaptionEditor />
                    </Suspense>
                )}

                <AnimatePresence>
                    {controlsShown && (
                        <motion.div
                            key="chrome"
                            data-studio-ui
                            className="pointer-events-none absolute inset-0"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={fade}
                        >
                            {/* One top column: status centred, scopes below it right-aligned. Never overlapping. */}
                            <div className="absolute inset-x-3 top-3 flex flex-col items-center gap-2">
                                <div className="pointer-events-auto max-w-full">
                                    <StatusBar />
                                </div>
                                {!clean && !arOpen && (
                                    <div className="pointer-events-auto max-w-full self-end">
                                        <ScopesDock />
                                    </div>
                                )}
                            </div>
                            {!blocking && (
                                <div className="pointer-events-auto absolute inset-x-3 bottom-4 flex justify-center">
                                    <ControlDock
                                        open={panel}
                                        onOpenChange={setPanel}
                                        onAr={() => setArOpen(true)}
                                        onLoupe={setLoupeHeld}
                                        onSpace={() => {
                                            setPanel(null);
                                            onModal({ kind: "space" });
                                        }}
                                    />
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* AR editor stays visible regardless of idle: it is an editing mode. */}
                <AnimatePresence>
                    {arOpen && (
                        <div data-studio-ui className="absolute inset-0">
                            <Suspense fallback={null}>
                                <ArEditor onClose={() => setArOpen(false)} />
                            </Suspense>
                        </div>
                    )}
                </AnimatePresence>

                <Suspense fallback={null}>
                    {modal?.kind === "tutorial" && <Tutorial onClose={() => onModal(null)} />}
                    {modal?.kind === "calibrate" && <Calibration onClose={() => onModal(null)} />}
                    {modal?.kind === "space" && <SpaceCalibration onClose={() => onModal(null)} />}
                    {modal?.kind === "enrol" && <Enrol request={modal.request} onClose={() => onModal(null)} />}
                </Suspense>

                {radial && <RadialMenu x={radial.x} y={radial.y} onPick={pick} onClose={() => setRadial(null)} />}

                <p className="sr-only" aria-live="polite">
                    {controlsShown ? "" : t("studio.shell.hiddenHint")}
                </p>
            </div>
        </StudioContext.Provider>
    );
}
