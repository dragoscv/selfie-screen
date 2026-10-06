import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MotionConfig } from "motion/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { AppShell } from "./components/app-shell.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { useLiveStudio } from "./hooks/use-live-studio.js";
import { useSettingsSync } from "./hooks/use-settings.js";
import "./i18n/index.js";
import { sidecarClient } from "./lib/sidecar-client.js";
import { useAppStore } from "./store/app-store.js";
import "./styles.css";

function App() {
    useSettingsSync();
    useLiveStudio();

    const handleMessage = useAppStore((s) => s.handleMessage);
    const setConnected = useAppStore((s) => s.setSidecarConnected);
    const setError = useAppStore((s) => s.setSidecarError);
    const reducedMotion = useAppStore((s) => s.settings.appearance.reducedMotion);

    useEffect(() => {
        const offMessage = sidecarClient.onMessage(handleMessage);
        const offState = sidecarClient.onStateChange(setConnected);

        // `listen()` is async. If this effect is torn down before it resolves
        // (StrictMode double-invoke, or an HMR reload), calling the returned
        // unlistener is unsafe — hence the explicit disposed flag rather than
        // unlistening straight from the promise.
        let disposed = false;
        let stopReady: (() => void) | undefined;

        // The shell emits `sidecar://ready` when the service is listening, but it
        // may have fired before this webview loaded — so also poll once on mount.
        void listen<{ port: number }>("sidecar://ready", (event) => {
            sidecarClient.connect(event.payload.port);
        })
            .then((stop) => {
                if (disposed) stop();
                else stopReady = stop;
            })
            .catch(() => undefined);

        void invoke<{ running: boolean; port: number; error: string | null }>("sidecar_status")
            .then((status) => {
                if (disposed) return;
                if (status.port > 0) sidecarClient.connect(status.port);
                if (status.error) setError(status.error);
            })
            .catch(() => undefined);

        return () => {
            disposed = true;
            offMessage();
            offState();
            stopReady?.();
        };
    }, [handleMessage, setConnected, setError]);

    return (
        // "user" follows the Windows animation setting; the in-app switch forces it off.
        <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
            <AppShell />
            <Toaster
                position="bottom-right"
                closeButton
                toastOptions={{
                    // Inherit the live theme rather than sonner's own palette.
                    classNames: {
                        toast: "surface !rounded-panel !text-fg",
                        description: "!text-fg-muted",
                    },
                }}
            />
        </MotionConfig>
    );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// This module re-executes on HMR, and calling createRoot twice on the same
// container tears down the first root's DOM mid-flight. Cache it instead.
declare global {
    interface Window {
        __tikseeRoot?: ReturnType<typeof createRoot>;
    }
}

const root = (window.__tikseeRoot ??= createRoot(container));

root.render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>,
);



