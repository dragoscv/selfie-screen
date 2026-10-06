import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import { parseSettings, type IdentityProfile, type SignalEvent, type StudioSettings, type VisionSettings } from "@tiksee/core";
import { applyAppearance } from "@tiksee/ui";
import type { FrameStatsSnapshot } from "@tiksee/pets";
import { MotionConfig } from "motion/react";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";

import { SignalBatcher, type EnrolRequest } from "./components/studio/actions.js";
import { FrameStore } from "./components/studio/context.js";
import { SettingsPersister } from "./components/studio/persist.js";
import { StudioShell, type StudioModal } from "./components/studio/shell.js";
import i18n, { setLocale } from "./i18n/index.js";
import { StudioEngine, type VideoHealth } from "./lib/studio/engine.js";
import { sidecarClient } from "./lib/sidecar-client.js";
import "./styles.css";

type Stats = FrameStatsSnapshot & { backend: string; tracking: boolean; video: VideoHealth };

const SIGNAL_FLUSH_MS = 100;
const SNAPSHOT_MS = 500;

/**
 * The studio window: camera + filters + pets composited in one WebGPU frame.
 * The canvas is the PREVIEW; the engine renders the output (vcam) separately,
 * so the control surface drawn over it never reaches the stream. The stats
 * HUD is a DOM layer that F2 toggles and is off by default.
 */
function Studio() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<StudioEngine | null>(null);
    const [frames] = useState(() => new FrameStore());
    const [stats, setStats] = useState<Stats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hud, setHud] = useState(false);
    const [live, setLive] = useState<{ engine: StudioEngine; canvas: HTMLCanvasElement } | null>(null);
    const [studio, setStudio] = useState<StudioSettings | null>(null);
    const [vision, setVision] = useState<VisionSettings | null>(null);
    const [profiles, setProfiles] = useState<IdentityProfile[]>([]);
    const [petsHidden, setPetsHidden] = useState(false);
    const [modal, setModal] = useState<StudioModal>(null);
    const [loupe, setLoupe] = useState(false);
    const studioRef = useRef<StudioSettings | null>(null);
    const visionRef = useRef<VisionSettings | null>(null);
    const persistRef = useRef<SettingsPersister | null>(null);

    const patchStudio = useCallback((patch: Partial<StudioSettings>) => {
        const cur = studioRef.current;
        if (!cur) return;
        const next = { ...cur, ...patch };
        studioRef.current = next;
        setStudio(next);
        void engineRef.current?.applyStudio(next);
        persistRef.current?.queue({ studio: patch });
    }, []);

    const patchVision = useCallback((patch: Partial<VisionSettings>) => {
        const cur = visionRef.current;
        if (!cur) return;
        const next = { ...cur, ...patch };
        visionRef.current = next;
        setVision(next);
        void engineRef.current?.applyVision(next);
        persistRef.current?.queue({ vision: patch });
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let disposed = false;
        const unlisten: (() => void)[] = [];
        let lastLog = 0;
        const keep = (stop: () => void) => {
            if (disposed) stop();
            else unlisten.push(stop);
        };
        const batcher = new SignalBatcher<SignalEvent>();
        const offEngine: (() => void)[] = [];
        let flushTimer = 0;
        const flushSignals = () => {
            flushTimer = 0;
            const events = batcher.drain();
            if (events.length > 0) sidecarClient.send({ type: "visionSignals", events });
        };

        void (async () => {
            // ?bench: measure the 1080p60 budget outside Tauri (plain browser, Playwright).
            const query = new URLSearchParams(location.search);
            const bench = query.has("bench");
            const store = bench || !isTauri() ? null : await load("settings.json", { autoSave: false }).catch(() => null);
            const settings = parseSettings(await store?.get("settings").catch(() => undefined));
            setLocale(settings.appearance.locale);
            // Shared @tiksee/ui controls (chips, switches, sliders) read the theme tokens from
            // <html data-accent/data-surface>; without them they rendered unstyled. The studio
            // is always dark glass over video, so the mode is forced dark.
            applyAppearance({ ...settings.appearance, mode: "dark", surface: "solid" });
            persistRef.current = new SettingsPersister(store !== null, (msg) => {
                if (isTauri()) void logError(`[studio] ${msg}`).catch(() => undefined);
            });
            if (bench) {
                const rot = Number(query.get("rot") ?? "90");
                Object.assign(settings.studio, {
                    leftPet: "parrot",
                    rightPet: "cat",
                    showStats: true,
                    rotation: [0, 90, 180, 270].includes(rot) ? rot : 90,
                });
            }
            if (disposed) return;
            setHud(settings.studio.showStats);
            studioRef.current = settings.studio;
            visionRef.current = settings.vision;
            setStudio(settings.studio);
            setVision(settings.vision);
            const engine = new StudioEngine(
                canvas,
                settings.studio,
                {
                onStats: (s) => {
                    setStats(s);
                    (window as { __tikseeStudioStats?: Stats }).__tikseeStudioStats = s;
                    const now = performance.now();
                    if (isTauri() && now - lastLog > 2000) {
                        lastLog = now;
                        void info(
                            `[studio] render ${s.fps.toFixed(1)} fps p95=${s.p95IntervalMs.toFixed(1)}ms cpu=${s.workMs.toFixed(2)}ms ` +
                                `cam ${s.video.fps.toFixed(1)} fps luma=${s.video.luma.toFixed(0)} ${s.video.state} ` +
                                `backend=${s.backend} tracking=${String(s.tracking)} frames=${s.frames} ${canvas.width}x${canvas.height}`,
                        ).catch(() => undefined);
                        const tm = (s as { timings?: Record<string, number> }).timings ?? {};
                        void info(
                            `[studio] timings ${Object.entries(tm)
                                .map(([k, v]) => `${k}=${v.toFixed(1)}`)
                                .join(" ")}`,
                        ).catch(() => undefined);
                    }
                },
                onError: (msg) => {
                    setError(msg);
                    (window.__tikseeStudioSteps ??= []).push(`error: ${msg}`);
                    // Visible feedback: a camera button that fails must say why, not do nothing.
                    if (msg.startsWith("camera")) toast.error(msg, { id: "camera-error" });
                    if (isTauri()) void logError(`[studio] ${msg}`).catch(() => undefined);
                },
                onStep: (step) => {
                    // Start-up trace for ?bench runs in a plain browser, where the Tauri log is absent.
                    (window.__tikseeStudioSteps ??= []).push(step);
                    if (isTauri()) void info(`[studio] step: ${step}`).catch(() => undefined);
                },
                onSettingsPatch: (patch) => {
                    // Already applied by the engine: mirror into React state and persist.
                    const cur = studioRef.current;
                    if (cur) {
                        studioRef.current = { ...cur, ...patch };
                        setStudio(studioRef.current);
                    }
                    persistRef.current?.queue({ studio: patch });
                },
                onLoupe: setLoupe,
                onClip: async (clip) => {
                    if (!isTauri()) {
                        (window as { __tikseeLastClip?: { name: string; bytes: number; seconds: number } }).__tikseeLastClip = {
                            name: clip.name,
                            bytes: clip.bytes.byteLength,
                            seconds: clip.seconds,
                        };
                        return;
                    }
                    const path = await invoke<string>("clip_save", new Uint8Array(clip.bytes), { headers: { "x-name": clip.name } });
                    void info(`[studio] clip ${path} ${clip.seconds.toFixed(1)} s ${(clip.bytes.byteLength / 1_048_576).toFixed(1)} MB`).catch(() => undefined);
                    toast.success(i18n.t("studio.clips.saved", { seconds: Math.round(clip.seconds) }), {
                        id: "clip-saved",
                        action: { label: i18n.t("studio.clips.show"), onClick: () => void revealItemInDir(path).catch(() => undefined) },
                    });
                },
                },
                { synthetic: query.get("bench") === "synthetic", vision: settings.vision },
            );
            engineRef.current = engine;
            offEngine.push(
                engine.onFrame((frame) => frames.set(frame)),
                engine.onSignals((events, armed) => {
                    const { armChanged } = batcher.push(events, armed);
                    if (armChanged) sidecarClient.send({ type: "visionArm", armed });
                    if (events.length > 0 && flushTimer === 0) flushTimer = window.setTimeout(flushSignals, SIGNAL_FLUSH_MS);
                }),
            );
            setLive({ engine, canvas });
            (window.__tikseeStudioSteps ??= []).push("engine created");
            try {
                await engine.start();
            } catch (e) {
                setError(String(e));
                if (isTauri()) void logError(`[studio] start failed: ${String(e)}`).catch(() => undefined);
                return;
            }
            if (disposed) engine.stop();
        })();

        const snapshotTimer = window.setInterval(() => {
            const info = frames.get();
            if (info && sidecarClient.connected) sidecarClient.send({ type: "visionSnapshot", snapshot: info.snapshot });
        }, SNAPSHOT_MS);
        const offState = sidecarClient.onStateChange((connected) => {
            if (connected) sidecarClient.send({ type: "identityList" });
        });
        if (sidecarClient.connected) sidecarClient.send({ type: "identityList" });

        const saveClip = () => {
            void engineRef.current?.saveClip().catch((e: unknown) => toast.error(i18n.t("studio.clips.failed", { error: String(e) }), { id: "clip-saved" }));
        };

        const offMessage = sidecarClient.onMessage((m) => {
            if (m.type === "identities") {
                setProfiles(m.profiles);
                engineRef.current?.setProfiles(m.profiles);
                return;
            }
            const engine = engineRef.current;
            if (!engine) return;
            if (m.type === "events") for (const ev of m.events) engine.onChat(ev);
            else if (m.type === "speech") engine.speak(m.visemes);
            else if (m.type === "liveControl") {
                engine.setHidden(m.state.petsHidden);
                setPetsHidden(m.state.petsHidden);
            } else if (m.type === "ruleAction") {
                if (m.action.type === "studio" && m.action.action === "saveClip") saveClip();
                else void engine.run(m.action).catch((e: unknown) => setError(`rule: ${String(e)}`));
            }
        });
        if (isTauri()) {
            void listen<StudioSettings>("studio://settings", (e) => {
                setHud(e.payload.showStats);
                studioRef.current = e.payload;
                setStudio(e.payload);
                void engineRef.current?.applyStudio(e.payload);
            }).then(keep);
            void listen<VisionSettings>("studio://vision", (e) => {
                visionRef.current = e.payload;
                setVision(e.payload);
                void engineRef.current?.applyVision(e.payload);
            }).then(keep);
            void listen<EnrolRequest>("studio://enrol", (e) => setModal({ kind: "enrol", request: e.payload })).then(keep);
            void listen<{ mode: "tutorial" | "calibrate" }>("studio://tutorial", (e) =>
                setModal({ kind: e.payload.mode === "calibrate" ? "calibrate" : "tutorial" }),
            ).then(keep);
            void listen("studio://space", () => setModal({ kind: "space" })).then(keep);
            void listen<{ port: number }>("sidecar://ready", (e) => sidecarClient.connect(e.payload.port)).then(keep);
            // Global hotkeys broadcast to every window; the studio owns the clip buffer.
            void listen<string>("hotkey", (e) => {
                if (e.payload === "saveClip") saveClip();
            }).then(keep);
            void invoke<{ port: number }>("sidecar_status")
                .then((s) => {
                    if (!disposed && s.port > 0) sidecarClient.connect(s.port);
                })
                .catch(() => undefined);
        }

        const onKey = (e: KeyboardEvent) => {
            if (e.key === "F2") setHud((v) => !v);
        };
        window.addEventListener("keydown", onKey);
        // Closing the window or a full reload tears the page down without
        // running React cleanup; an unstopped MediaStreamTrack keeps the
        // capture device locked ("Device in use") for the next open.
        const release = () => {
            void persistRef.current?.flush();
            engineRef.current?.stop();
        };
        window.addEventListener("pagehide", release);
        window.addEventListener("beforeunload", release);
        import.meta.hot?.dispose(release);

        return () => {
            disposed = true;
            offMessage();
            offState();
            offEngine.forEach((stop) => stop());
            window.clearInterval(snapshotTimer);
            window.clearTimeout(flushTimer);
            flushSignals();
            unlisten.forEach((stop) => stop());
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pagehide", release);
            window.removeEventListener("beforeunload", release);
            void persistRef.current?.flush();
            engineRef.current?.stop();
            engineRef.current = null;
        };
    }, [frames]);

    return (
        <div className="dark" style={{ position: "relative", width: "100%", height: "100%", display: "grid", placeItems: "center" }}>
            <canvas
                ref={canvasRef}
                aria-label="TikSee studio preview"
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
            {live && studio && vision && (
                <StudioShell
                    controller={live.engine}
                    canvas={live.canvas}
                    frames={frames}
                    studio={studio}
                    vision={vision}
                    profiles={profiles}
                    petsHidden={petsHidden}
                    modal={modal}
                    onModal={setModal}
                    loupe={loupe}
                    patchStudio={patchStudio}
                    patchVision={patchVision}
                />
            )}
            {hud && (
                <output
                    style={{
                        position: "absolute",
                        bottom: 8,
                        left: 8,
                        padding: "6px 8px",
                        font: "12px/1.4 ui-monospace, monospace",
                        color: "#e8f6ff",
                        background: "rgb(0 0 0 / 0.65)",
                        borderRadius: 6,
                    }}
                >
                    {stats
                        ? `${stats.fps.toFixed(1)} fps · p95 ${stats.p95IntervalMs.toFixed(1)} ms · cpu ${stats.workMs.toFixed(1)} ms · ${stats.backend} · ${stats.tracking ? "tracking" : "no person"} · cam ${stats.video.fps.toFixed(0)} fps ${stats.video.state} luma ${stats.video.luma.toFixed(0)}`
                        : "starting…"}
                    {error && <div style={{ color: "#ffb4a8" }}>{error}</div>}
                </output>
            )}
        </div>
    );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from studio.html");

declare global {
    interface Window {
        __tikseeStudioRoot?: ReturnType<typeof createRoot>;
        __tikseeStudioSteps?: string[];
    }
}

const root = (window.__tikseeStudioRoot ??= createRoot(container));
root.render(
    <StrictMode>
        <MotionConfig reducedMotion="user">
            <Studio />
            <Toaster
                position="top-right"
                theme="dark"
                closeButton
                toastOptions={{ classNames: { toast: "!bg-neutral-950/85 !text-white !border-white/15 backdrop-blur-xl" } }}
            />
        </MotionConfig>
    </StrictMode>,
);
