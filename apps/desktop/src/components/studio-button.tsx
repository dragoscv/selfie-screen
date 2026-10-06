import { invoke, isTauri } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@tiksee/ui";
import { Clapperboard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useSettingsUpdate } from "../hooks/use-settings.js";
import { useAppStore } from "../store/app-store.js";

const POLL_MS = 1500;

/**
 * Titlebar button that opens (or focuses) the Studio window. It follows the
 * real window, not the persisted `studio.enabled` flag, which stayed true
 * after the user closed the window.
 */
export function StudioButton() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const portrait = useAppStore((s) => s.settings.studio.orientation === "portrait");
    const [open, setOpen] = useState(false);

    const refresh = useCallback(async () => {
        if (!isTauri()) return;
        const w = await WebviewWindow.getByLabel("studio").catch(() => null);
        setOpen(w !== null);
    }, []);

    useEffect(() => {
        const first = window.setTimeout(() => void refresh(), 0);
        const id = window.setInterval(() => void refresh(), POLL_MS);
        return () => {
            window.clearTimeout(first);
            window.clearInterval(id);
        };
    }, [refresh]);

    const toggle = () => {
        update("studio", { enabled: true });
        invoke("toggle_studio", { show: true, portrait })
            .then(() => setOpen(true))
            .catch((e: unknown) => toast.error(String(e)));
    };

    return (
        <button
            type="button"
            onClick={toggle}
            title={open ? t("nav.studioFocus") : t("nav.studioOpen")}
            aria-label={open ? t("nav.studioFocus") : t("nav.studioOpen")}
            className={cn(
                "flex items-center gap-1.5 rounded-chip px-2.5 py-1.5 text-xs font-semibold outline-none",
                "transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                open ? "bg-accent-subtle text-accent" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent",
            )}
        >
            <Clapperboard className="size-3.5" aria-hidden />
            <span className="hidden md:inline">{t("nav.studio")}</span>
            {open && <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />}
        </button>
    );
}
