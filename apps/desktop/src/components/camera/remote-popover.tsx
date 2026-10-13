import type { CameraRemoteSettings } from "@tiksee/core";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useSettingsUpdate } from "../../hooks/use-settings.js";
import { openRemoteWindow } from "../../lib/camera-remote.js";
import { useAppStore } from "../../store/app-store.js";
import { RemotePanel } from "./remote-panel.js";

/** Camera remote dropped from the Live Control bar (lazy chunk); Esc or outside click closes it. */
export function RemotePopover({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const settings = useAppStore((s) => s.settings.cameraRemote);
    const update = useSettingsUpdate();
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const onDown = (e: PointerEvent) => {
            const target = e.target as Element | null;
            if (ref.current && target && !ref.current.contains(target) && !target.closest("[data-remote-toggle]")) onClose();
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onDown);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("pointerdown", onDown);
        };
    }, [onClose]);

    const patch = (p: Partial<CameraRemoteSettings>) => update("cameraRemote", p);
    const detach = () => {
        openRemoteWindow(settings.alwaysOnTop)
            .then(onClose)
            .catch((e: unknown) => toast.error(String(e)));
    };

    return (
        <div
            ref={ref}
            role="dialog"
            aria-label={t("cameraRemote.title")}
            className="surface absolute left-3 top-full z-40 mt-1 max-h-[min(80vh,640px)] w-80 overflow-y-auto rounded-panel border border-border p-3 shadow-xl"
        >
            <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold text-fg">{t("cameraRemote.title")}</h2>
                <button
                    type="button"
                    onClick={detach}
                    className="no-drag ml-auto inline-flex items-center gap-1 rounded-chip bg-panel-alt px-2 py-1 text-[0.6875rem] text-fg outline-none hover:bg-accent-subtle hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t("cameraRemote.detach")}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t("common.close")}
                    className="no-drag grid size-8 place-items-center rounded-full text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="size-4" aria-hidden />
                </button>
            </div>
            <RemotePanel settings={settings} onPatch={patch} />
        </div>
    );
}
