import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { parseSettings, type CameraRemoteSettings, type Settings } from "@tiksee/core";
import { applyAppearance, cn } from "@tiksee/ui";
import { Camera, GripHorizontal, Pin, PinOff, X } from "lucide-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";

import { RemotePanel } from "./components/camera/remote-panel.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import "./i18n/index.js";
import { setLocale } from "./i18n/index.js";
import "./styles.css";

/**
 * Detached camera remote (its own Tauri window, label `camera-remote`): works
 * with the Studio closed. The main window owns the settings; this window reads
 * the store once, follows `remote://settings` and sends `remote://patch`.
 * Position and size are restored by the window-state plugin.
 */
function RemoteWindow() {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<CameraRemoteSettings | null>(null);

    useEffect(() => {
        let disposed = false;
        let stop: (() => void) | undefined;
        void (async () => {
            const store = isTauri() ? await load("settings.json", { autoSave: false }).catch(() => null) : null;
            const all: Settings = parseSettings(await store?.get("settings").catch(() => undefined));
            if (disposed) return;
            applyAppearance({ ...all.appearance, surface: "glass" });
            setLocale(all.appearance.locale);
            setSettings((s) => s ?? all.cameraRemote);
        })();
        void listen<CameraRemoteSettings>("remote://settings", (e) => setSettings(e.payload))
            .then((fn) => {
                if (disposed) fn();
                else stop = fn;
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);

    const onTop = settings?.alwaysOnTop ?? true;
    useEffect(() => {
        void getCurrentWindow()
            .setAlwaysOnTop(onTop)
            .catch(() => undefined);
    }, [onTop]);

    const patch = (p: Partial<CameraRemoteSettings>) => {
        setSettings((s) => (s ? { ...s, ...p } : s));
        void emitTo("main", "remote://patch", p).catch(() => undefined);
    };

    return (
        <div className="surface flex h-screen flex-col overflow-hidden rounded-card border border-fg/10">
            <header className="drag-region flex h-9 shrink-0 items-center gap-2 border-b border-fg/10 px-2.5">
                <GripHorizontal className="size-3.5 text-fg-subtle" aria-hidden />
                <Camera className="size-3.5 text-accent" aria-hidden />
                <h1 className="text-[0.6875rem] font-bold uppercase tracking-wider text-fg">{t("cameraRemote.title")}</h1>
                <div className="no-drag ml-auto flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-pressed={onTop}
                        onClick={() => patch({ alwaysOnTop: !onTop })}
                        aria-label={t("cameraRemote.onTop")}
                        title={t("cameraRemote.onTop")}
                        className={cn(
                            "grid size-8 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            onTop ? "text-accent" : "text-fg-subtle hover:text-fg",
                        )}
                    >
                        {onTop ? <Pin className="size-3.5" aria-hidden /> : <PinOff className="size-3.5" aria-hidden />}
                    </button>
                    <button
                        type="button"
                        onClick={() => void getCurrentWindow().close()}
                        aria-label={t("common.close")}
                        className="grid size-8 place-items-center rounded-full text-fg-subtle outline-none transition-colors hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="size-3.5" aria-hidden />
                    </button>
                </div>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto p-3">
                {settings ? <RemotePanel settings={settings} onPatch={patch} /> : <div className="h-40" aria-busy />}
            </main>
            <Toaster position="bottom-center" toastOptions={{ classNames: { toast: "surface !rounded-panel !text-fg" } }} />
        </div>
    );
}

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from remote.html");

// See main.tsx: a second root on the same container during HMR kills the webview.
declare global {
    interface Window {
        __tikseeRemoteRoot?: ReturnType<typeof createRoot>;
    }
}

const root = (window.__tikseeRemoteRoot ??= createRoot(container));

root.render(
    <StrictMode>
        <ErrorBoundary>
            <RemoteWindow />
        </ErrorBoundary>
    </StrictMode>,
);
