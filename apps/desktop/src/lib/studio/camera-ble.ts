import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CAMERA_ACTIONS } from "@tiksee/core";

import { safeUnlisten } from "../unloading.js";
import { OpticalEstimate } from "./optical-estimate.js";

export type CameraAction = (typeof CAMERA_ACTIONS)[number];
export type HoldAction = Extract<CameraAction, "zoomIn" | "zoomOut" | "focusNear" | "focusFar">;

/** Wire shape of the `camera_ble` Tauri command (src-tauri/src/camera/ble.rs `BleAction`). */
export interface BleCommand {
    action: "zoom" | "focus" | "af" | "photo" | "record";
    /** zoom: +tele / -wide, focus: -near / +far, |value| 1..3 = speed, 0 = release. One-shots send 0. */
    value: number;
}

export const DEFAULT_HOLD_MS = 300;

const HOLD: Readonly<Record<HoldAction, { action: "zoom" | "focus"; dir: 1 | -1 }>> = {
    zoomIn: { action: "zoom", dir: 1 },
    zoomOut: { action: "zoom", dir: -1 },
    focusNear: { action: "focus", dir: -1 },
    focusFar: { action: "focus", dir: 1 },
};

export function isHoldAction(a: CameraAction): a is HoldAction {
    return a in HOLD;
}

/** Press command for an action; zoom/focus carry direction x speed (1..3). */
export function bleCommand(action: CameraAction, speed: 1 | 2 | 3 = 1): BleCommand {
    if (isHoldAction(action)) {
        const h = HOLD[action];
        return { action: h.action, value: h.dir * Math.min(Math.max(Math.round(speed), 1), 3) };
    }
    return { action, value: 0 };
}

/** Release command for a held action, null for one-shots. */
export function bleRelease(action: CameraAction): BleCommand | null {
    return isHoldAction(action) ? { action: HOLD[action].action, value: 0 } : null;
}

/** Payload of `camera://ble` (BleState in ble.rs). */
export interface BleState {
    status: string;
    address?: string | null;
    recording: boolean;
    focused: boolean;
    error?: string | null;
}

export interface CameraStatus {
    connected: boolean;
    focused: boolean;
    recording: boolean;
}

export function cameraStatus(s: BleState | null): CameraStatus {
    return { connected: s?.status === "connected", focused: s?.focused ?? false, recording: s?.recording ?? false };
}

type Send = (cmd: BleCommand) => Promise<void>;

const tauriSend: Send = (cmd) => invoke<void>("camera_ble", { action: cmd.action, value: cmd.value });

/**
 * The Sony BLE remote as studio actions: one-shots (af/photo/record), timed
 * holds for rules (`camera` RuleAction with holdMs) and press/release for UI.
 */
export class CameraRemote {
    readonly #send: Send;
    #held: CameraAction | null = null;
    #holdTimer: ReturnType<typeof setTimeout> | null = null;
    #state: BleState | null = null;
    #unlisten: (() => void) | null = null;
    #onError: (message: string) => void;
    /** Estimated lens position from every zoom hold (the remote reports none). */
    readonly optical = new OpticalEstimate();

    constructor(onError: (message: string) => void = () => undefined, send: Send = tauriSend) {
        this.#send = send;
        this.#onError = onError;
    }

    get status(): CameraStatus {
        return cameraStatus(this.#state);
    }

    /** Follow `camera://ble` (no-op outside Tauri). */
    async listen(): Promise<void> {
        if (!isTauri() || this.#unlisten) return;
        this.#unlisten = await listen<BleState>("camera://ble", (e) => {
            this.#state = e.payload;
        });
        // The event fires only on change; a studio opened after the remote
        // connected would otherwise stay "disconnected" with disabled buttons.
        const now = await invoke<BleState | null>("camera_ble_state").catch(() => null);
        if (now && this.#state === null) this.#state = now;
    }

    #fire(cmd: BleCommand): Promise<void> {
        return this.#send(cmd).catch((e: unknown) => this.#onError(`camera ble ${cmd.action}: ${String(e)}`));
    }

    /** Rule/UI one-shot: zoom/focus press for `holdMs` then release; af/photo/record fire once. */
    async run(action: CameraAction, holdMs = DEFAULT_HOLD_MS): Promise<void> {
        if (!isHoldAction(action)) return this.#fire(bleCommand(action));
        this.hold(action, 1);
        await new Promise<void>((r) => {
            this.#holdTimer = setTimeout(r, holdMs);
        });
        if (this.#held === action) this.release();
    }

    hold(action: HoldAction, speed: 1 | 2 | 3): void {
        if (this.#held && this.#held !== action) this.release();
        this.#held = action;
        if (action === "zoomIn" || action === "zoomOut") this.optical.hold(action === "zoomIn" ? 1 : -1, speed, performance.now());
        void this.#fire(bleCommand(action, speed));
    }

    release(): void {
        if (this.#holdTimer) clearTimeout(this.#holdTimer);
        this.#holdTimer = null;
        const held = this.#held;
        this.#held = null;
        if (held === "zoomIn" || held === "zoomOut") this.optical.release(performance.now());
        const cmd = held ? bleRelease(held) : null;
        if (cmd) void this.#fire(cmd);
    }

    dispose(): void {
        this.release();
        safeUnlisten(this.#unlisten);
        this.#unlisten = null;
    }
}
