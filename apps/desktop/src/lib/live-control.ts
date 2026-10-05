import type { ControlAction, LiveControlState } from "@tiksee/core";
import { invoke } from "@tauri-apps/api/core";

import { useAppStore } from "../store/app-store.js";
import { sidecarClient } from "./sidecar-client.js";

/** Toggleable controls: the "on" action, the "off" action and the state flag that tells them apart. */
export const TOGGLE_CONTROLS = {
    mute: { on: "muteAssistant", off: "unmuteAssistant", flag: "muted" },
    pause: { on: "pauseReplies", off: "resumeReplies", flag: "repliesPaused" },
    effects: { on: "effectsOff", off: "effectsOn", flag: "effectsOff" },
    shop: { on: "shopModeOn", off: "shopModeOff", flag: "shopMode" },
    pets: { on: "petsHide", off: "petsShow", flag: "petsHidden" },
} as const satisfies Record<string, { on: ControlAction; off: ControlAction; flag: keyof LiveControlState }>;

export type ToggleControl = keyof typeof TOGGLE_CONTROLS;

export function sendControl(action: ControlAction): void {
    sidecarClient.send({ type: "control", action });
}

/** Flip a toggle based on the live state the sidecar last reported. */
export function toggleControl(control: ToggleControl): void {
    const { on, off, flag } = TOGGLE_CONTROLS[control];
    const active = useAppStore.getState().liveControl[flag] === true;
    sendControl(active ? off : on);
}

/** Show/hide the floating overlay window, keeping the setting in sync. */
export function toggleOverlayWindow(): void {
    const { settings, updateSettings } = useAppStore.getState();
    const next = !settings.overlay.enabled;
    updateSettings((current) => ({ ...current, overlay: { ...current.overlay, enabled: next } }));
    void invoke("toggle_overlay", { show: next }).catch(() => undefined);
}

/** Legacy payloads emitted by older shells, mapped to their current names. */
const LEGACY_HOTKEYS: Record<string, string> = { overlay: "toggleOverlay", mute: "muteAssistant", ptt: "pushToTalk" };

/**
 * Run a global-hotkey payload. Payloads are CONTROL_ACTIONS names plus
 * `toggleOverlay` and `pushToTalk`. A hotkey is a single key press, so either
 * half of an on/off pair toggles — pressing "mute" while muted unmutes.
 */
export function runHotkey(raw: string, onPushToTalk: () => void): void {
    const action = LEGACY_HOTKEYS[raw] ?? raw;
    if (action === "toggleOverlay") {
        toggleOverlayWindow();
        return;
    }
    if (action === "pushToTalk") {
        onPushToTalk();
        return;
    }
    for (const [control, pair] of Object.entries(TOGGLE_CONTROLS) as [ToggleControl, (typeof TOGGLE_CONTROLS)[ToggleControl]][]) {
        if (pair.on === action || pair.off === action) {
            toggleControl(control);
            return;
        }
    }
    if (action === "skipCurrent" || action === "highlight") sendControl(action);
}
