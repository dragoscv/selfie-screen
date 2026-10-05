import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { load } from "@tauri-apps/plugin-store";
import { parseSettings, type StudioSettings } from "@tiksee/core";
import type { FrameStatsSnapshot } from "@tiksee/pets";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { StudioEngine, type VideoHealth } from "./lib/studio/engine.js";
import { sidecarClient } from "./lib/sidecar-client.js";

type Stats = FrameStatsSnapshot & { backend: string; tracking: boolean; video: VideoHealth };

/**
 * The studio window: camera + filters + pets composited in one WebGPU frame.
 * It is a bare full-bleed canvas so OBS window capture sees only the frame;
 * the stats HUD is a DOM layer that F2 toggles and is off by default.
 */
function Studio() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<StudioEngine | null>(null);
    const [stats, setStats] = useState<Stats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hud, setHud] = useState(false);

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

        void (async () => {
            // ?bench: measure the 1080p60 budget outside Tauri (plain browser, Playwright).
            const query = new URLSearchParams(location.search);
            const bench = query.has("bench");
            const store = bench || !isTauri() ? null : await load("settings.json", { autoSave: false }).catch(() => null);
            const settings = parseSettings(await store?.get("settings").catch(() => undefined));
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
                    }
                },
                onError: (msg) => {
                    setError(msg);
                    if (isTauri()) void logError(`[studio] ${msg}`).catch(() => undefined);
                },
                onStep: (step) => {
                    if (isTauri()) void info(`[studio] step: ${step}`).catch(() => undefined);
                },
                },
                { synthetic: query.get("bench") === "synthetic" },
            );
            engineRef.current = engine;
            try {
                await engine.start();
            } catch (e) {
                setError(String(e));
                if (isTauri()) void logError(`[studio] start failed: ${String(e)}`).catch(() => undefined);
                return;
            }
            if (disposed) engine.stop();
        })();

        const offMessage = sidecarClient.onMessage((m) => {
            const engine = engineRef.current;
            if (!engine) return;
            if (m.type === "events") for (const ev of m.events) engine.onChat(ev);
            else if (m.type === "speech") engine.speak(m.visemes);
            else if (m.type === "liveControl") engine.setHidden(m.state.petsHidden);
        });
        if (isTauri()) {
            void listen<StudioSettings>("studio://settings", (e) => {
                setHud(e.payload.showStats);
                void engineRef.current?.apply(e.payload);
            }).then(keep);
            void listen<{ port: number }>("sidecar://ready", (e) => sidecarClient.connect(e.payload.port)).then(keep);
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
        const release = () => engineRef.current?.stop();
        window.addEventListener("pagehide", release);
        window.addEventListener("beforeunload", release);
        import.meta.hot?.dispose(release);

        return () => {
            disposed = true;
            offMessage();
            unlisten.forEach((stop) => stop());
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pagehide", release);
            window.removeEventListener("beforeunload", release);
            engineRef.current?.stop();
            engineRef.current = null;
        };
    }, []);

    return (
        <div style={{ position: "relative", width: "100%", height: "100%", display: "grid", placeItems: "center" }}>
            <canvas
                ref={canvasRef}
                aria-label="TikSee studio output"
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            />
            {hud && (
                <output
                    style={{
                        position: "absolute",
                        top: 8,
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
    }
}

const root = (window.__tikseeStudioRoot ??= createRoot(container));
root.render(
    <StrictMode>
        <Studio />
    </StrictMode>,
);
