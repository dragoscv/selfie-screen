import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { AppShell } from "./components/app-shell.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { useSettingsSync } from "./hooks/use-settings.js";
import "./i18n/index.js";
import { sidecarClient } from "./lib/sidecar-client.js";
import { useAppStore } from "./store/app-store.js";
import "./styles.css";

function App() {
    useSettingsSync();

    const handleMessage = useAppStore((s) => s.handleMessage);
    const setConnected = useAppStore((s) => s.setSidecarConnected);
    const setError = useAppStore((s) => s.setSidecarError);

    useEffect(() => {
        const offMessage = sidecarClient.onMessage(handleMessage);
        const offState = sidecarClient.onStateChange(setConnected);

        // The shell emits `sidecar://ready` when the service is listening, but it
        // may have fired before this webview loaded — so also poll once on mount.
        const unlistenReady = listen<{ port: number }>("sidecar://ready", (event) => {
            sidecarClient.connect(event.payload.port);
        });

        void invoke<{ running: boolean; port: number; error: string | null }>("sidecar_status")
            .then((status) => {
                if (status.port > 0) sidecarClient.connect(status.port);
                if (status.error) setError(status.error);
            })
            .catch(() => undefined);

        return () => {
            offMessage();
            offState();
            void unlistenReady.then((fn) => fn());
        };
    }, [handleMessage, setConnected, setError]);

    return (
        <>
            <AppShell />
            <Toaster
                position="bottom-right"
                closeButton
                toastOptions={{
                    // Inherit the live theme rather than sonner's own palette.
                    classNames: {
                        toast: "surface !rounded-[--radius-panel] !text-fg",
                        description: "!text-fg-muted",
                    },
                }}
            />
        </>
    );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>,
);
