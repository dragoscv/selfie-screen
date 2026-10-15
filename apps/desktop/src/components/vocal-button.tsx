import { isTauri } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@tiksee/ui";
import { AudioLines } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { openVocalWindow } from "../lib/vocal.js";
import { useAppStore } from "../store/app-store.js";

const POLL_MS = 1500;

/** Titlebar button next to Studio: opens (or focuses) the vocal window; the dot = engine on. */
export function VocalButton() {
    const { t } = useTranslation();
    const vocal = useAppStore((s) => s.settings.vocal);
    const [open, setOpen] = useState(false);

    const refresh = useCallback(async () => {
        if (!isTauri()) return;
        const w = await WebviewWindow.getByLabel("vocal").catch(() => null);
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

    const label = open ? t("vocal.focus") : t("vocal.open");
    return (
        <button
            type="button"
            onClick={() =>
                openVocalWindow(vocal.alwaysOnTop)
                    .then(() => setOpen(true))
                    .catch((e: unknown) => toast.error(String(e)))
            }
            title={label}
            aria-label={label}
            className={cn(
                "flex items-center gap-1.5 rounded-chip px-2.5 py-1.5 text-xs font-semibold outline-none",
                "transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                open ? "bg-accent-subtle text-accent" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent",
            )}
        >
            <AudioLines className="size-3.5" aria-hidden />
            <span className="hidden md:inline">{t("vocal.button")}</span>
            {vocal.enabled && <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />}
        </button>
    );
}
