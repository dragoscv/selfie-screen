import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyAppearance, cn } from "@tiksee/ui";
import { GripHorizontal, Settings2, X } from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { ChatFeed } from "./components/chat-feed.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import "./i18n/index.js";
import { setLocale } from "./i18n/index.js";
import { sidecarClient } from "./lib/sidecar-client.js";
import { MAIN_STREAM, selectEvents, selectStatus, useAppStore } from "./store/app-store.js";
import "./styles.css";

/**
 * The always-on-top floating overlay.
 *
 * A separate entry point rather than a route: it is a distinct OS window with
 * its own lifecycle, and keeping it out of the main bundle means it stays
 * lightweight enough to sit over a game or OBS without costing frames.
 */
function Overlay() {
    const events = useAppStore(selectEvents(MAIN_STREAM));
    const status = useAppStore(selectStatus(MAIN_STREAM));
    const settings = useAppStore((s) => s.settings);
    const handleMessage = useAppStore((s) => s.handleMessage);
    const setConnected = useAppStore((s) => s.setSidecarConnected);

    const [showControls, setShowControls] = useState(false);

    useEffect(() => {
        const offMessage = sidecarClient.onMessage(handleMessage);
        const offState = sidecarClient.onStateChange(setConnected);

        // `listen()` resolves asynchronously; unmounting first would otherwise
        // leave the cleanup calling an unresolved unlistener.
        let disposed = false;
        let stopReady: (() => void) | undefined;

        void listen<{ port: number }>("sidecar://ready", (event) =>
            sidecarClient.connect(event.payload.port),
        )
            .then((stop) => {
                if (disposed) stop();
                else stopReady = stop;
            })
            .catch(() => undefined);

        void invoke<{ port: number }>("sidecar_status")
            .then((s) => {
                if (!disposed && s.port > 0) sidecarClient.connect(s.port);
            })
            .catch(() => undefined);

        return () => {
            disposed = true;
            offMessage();
            offState();
            stopReady?.();
        };
    }, [handleMessage, setConnected]);

    // The overlay is a second window with its own document, so it must apply
    // the theme itself; it does not inherit the main window's <html> attributes.
    useEffect(() => {
        applyAppearance({ ...settings.appearance, surface: "glass" });
        setLocale(settings.appearance.locale);
    }, [settings.appearance]);

    const { opacity, blur, compact } = settings.overlay;

    return (
        <div
            className="flex h-screen flex-col overflow-hidden rounded-[--radius-card] border border-fg/10"
            style={{
                // Opacity and blur trade off: with real blur the scrim must get
                // lighter or the frost is hidden behind an opaque panel.
                background: `color-mix(in oklab, var(--bg) ${Math.round(
                    Math.max(0.05, opacity - blur * 0.4) * 100,
                )}%, transparent)`,
                backdropFilter: blur > 0.02 ? `blur(${Math.round(blur * 28)}px) saturate(1.5)` : undefined,
            }}
        >
            <header
                className="drag-region flex h-8 shrink-0 items-center gap-2 border-b border-fg/10 px-2.5"
                onDoubleClick={() => setShowControls((value) => !value)}
            >
                <GripHorizontal className="size-3.5 text-fg-subtle" aria-hidden />
                <span
                    className={cn(
                        "size-1.5 rounded-full",
                        status.state === "live" ? "bg-success" : "bg-fg-subtle",
                    )}
                    aria-hidden
                />
                <span className="text-[0.625rem] font-bold uppercase tracking-wider text-fg">
                    Live chat
                </span>
                <div className="no-drag ml-auto flex items-center gap-0.5">
                    <button
                        type="button"
                        onClick={() => setShowControls((value) => !value)}
                        aria-label="Controls"
                        className={cn(
                            "grid size-6 place-items-center rounded-full outline-none transition-colors",
                            showControls ? "text-accent" : "text-fg-subtle hover:text-fg",
                        )}
                    >
                        <Settings2 className="size-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => void getCurrentWindow().hide()}
                        aria-label="Close"
                        className="grid size-6 place-items-center rounded-full text-fg-subtle outline-none transition-colors hover:text-danger"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            </header>

            {showControls && <OverlayControls />}

            <ErrorBoundary area="overlay">
                <ChatFeed
                    events={events}
                    state={status.state}
                    compact={compact}
                    className="min-h-0 flex-1"
                />
            </ErrorBoundary>
        </div>
    );
}

function OverlayControls() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);

    const patch = (key: "opacity" | "blur", value: number) =>
        updateSettings((current) => ({
            ...current,
            overlay: { ...current.overlay, [key]: value },
        }));

    return (
        <div className="shrink-0 space-y-1.5 border-b border-fg/10 bg-black/20 px-3 py-2">
            <MiniSlider
                label="Opacity"
                value={settings.overlay.opacity}
                min={0.15}
                onChange={(value) => patch("opacity", value)}
            />
            <MiniSlider
                label="Blur"
                value={settings.overlay.blur}
                min={0}
                tint="var(--kind-join)"
                onChange={(value) => patch("blur", value)}
            />
        </div>
    );
}

function MiniSlider({
    label,
    value,
    min,
    tint,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    tint?: string;
    onChange: (value: number) => void;
}) {
    return (
        <label className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[0.625rem] text-fg-subtle">{label}</span>
            <input
                type="range"
                min={min}
                max={1}
                step={0.01}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="no-drag h-1 flex-1 cursor-pointer appearance-none rounded-full bg-fg/15 accent-[var(--t)]"
                style={{ "--t": tint ?? "var(--accent)" } as React.CSSProperties}
            />
            <span className="w-8 shrink-0 text-right text-[0.625rem] font-bold tabular-nums" style={{ color: tint ?? "var(--accent)" }}>
                {Math.round(value * 100)}%
            </span>
        </label>
    );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from overlay.html");

// See main.tsx: creating a second root on the same container during HMR
// tears down the first root's DOM mid-flight.
declare global {
    interface Window {
        __tikseeOverlayRoot?: ReturnType<typeof createRoot>;
    }
}

const root = (window.__tikseeOverlayRoot ??= createRoot(container));

root.render(
    <StrictMode>
        <ErrorBoundary>
            <Overlay />
        </ErrorBoundary>
    </StrictMode>,
);
