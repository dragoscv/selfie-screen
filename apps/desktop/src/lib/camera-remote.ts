import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CameraRemoteSettings, CameraTransport, RemoteAction } from "@tiksee/core";
import { useEffect, useState } from "react";

import type { CameraState, UsbStatus } from "./camera-format.js";
import type { BleState } from "./studio/camera-ble.js";

/** Route the shell picked for a press (`camera_remote` in src-tauri/src/camera/mod.rs). */
export type RemoteRoute = "ble" | "usb";

export const HOLD_ACTIONS = ["zoomIn", "zoomOut", "focusNear", "focusFar"] as const satisfies readonly RemoteAction[];
export const isHold = (a: RemoteAction): boolean => (HOLD_ACTIONS as readonly string[]).includes(a);

/** Press (`down`) or release one remote button; works with the Studio closed. */
export function pressRemote(action: RemoteAction, down: boolean, speed: number, transport: CameraTransport): Promise<RemoteRoute> {
    return invoke<RemoteRoute>("camera_remote", { action, down, speed, transport });
}

/** Open (or focus) the detached remote window. */
export function openRemoteWindow(onTop: boolean): Promise<void> {
    return invoke<void>("toggle_camera_remote", { show: true, onTop });
}

/** Push the selfie-stick config to the shell (it owns the Raw Input listener). */
export function configureSelfie(r: CameraRemoteSettings): Promise<void> {
    return invoke<void>("camera_hid_configure", {
        config: { ...r.selfie, transport: r.transport, speed: r.speed },
    });
}

/** Follow an event plus its current value (events only fire on change). */
function useCameraEvent<T>(event: string, initial: () => Promise<T | null>): T | null {
    const [state, setState] = useState<T | null>(null);
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        void listen<T>(event, (e) => setState(e.payload))
            .then((fn) => {
                if (disposed) fn();
                else stop = fn;
            })
            .catch(() => undefined);
        void initial()
            .then((now) => {
                if (!disposed && now) setState((s) => s ?? now);
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            stop?.();
        };
    }, [event, initial]);
    return state;
}

const bleNow = () => invoke<BleState | null>("camera_ble_state");
const usbNow = () =>
    invoke<UsbStatus>("camera_usb_status").then((s) => (s.state ? (s.running ? s.state : { ...s.state, mode: "off" as const }) : null));

export const useBleState = (): BleState | null => useCameraEvent<BleState>("camera://ble", bleNow);
export const useUsbState = (): CameraState | null => useCameraEvent<CameraState>("camera://state", usbNow);

export const usbReady = (s: CameraState | null): boolean => s?.connected === true && s.mode !== "off";

/** Which transport a press would take right now (mirrors `remote::route`). */
export function activeRoute(transport: CameraTransport, ble: BleState | null, usb: CameraState | null): RemoteRoute | null {
    const usbOk = usbReady(usb);
    const bleOk = ble?.status === "connected";
    if (transport === "usb") return usbOk ? "usb" : null;
    if (transport === "ble") return bleOk ? "ble" : null;
    if (usbOk) return "usb";
    return bleOk ? "ble" : null;
}
