import type { VisionSettings } from "@tiksee/core";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";

import { useSettingsUpdate } from "../../hooks/use-settings.js";
import { useAppStore } from "../../store/app-store.js";

/** Vision settings plus a patcher; every change also reaches the sidecar via the settings sync. */
export function useVisionSettings(): readonly [VisionSettings, (patch: Partial<VisionSettings>) => void] {
    const vision = useAppStore((s) => s.settings.vision);
    const update = useSettingsUpdate();
    const patch = useCallback((p: Partial<VisionSettings>) => update("vision", p), [update]);
    return [vision, patch] as const;
}

/** The studio window is a separate document; mirror vision settings to it live (like StudioSection). */
export function usePushVisionToStudio(): void {
    const vision = useAppStore((s) => s.settings.vision);
    useEffect(() => {
        void emitTo("studio", "studio://vision", vision).catch(() => undefined);
    }, [vision]);
}

/** Opens (or focuses) the studio window and marks it enabled. */
export function useOpenStudio(): () => Promise<void> {
    const update = useSettingsUpdate();
    const orientation = useAppStore((s) => s.settings.studio.orientation);
    return useCallback(async () => {
        update("studio", { enabled: true });
        await invoke("toggle_studio", { show: true, portrait: orientation === "portrait" });
    }, [update, orientation]);
}

export { useVisionLabels, type VisionLabels } from "./labels.js";
