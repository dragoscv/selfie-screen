import { invoke } from "@tauri-apps/api/core";
import { CAMERA_TRANSPORTS, type CameraRemoteSettings, type CameraTransport, type RemoteAction } from "@tiksee/core";
import { ChipSelector, cn, StatusPill } from "@tiksee/ui";
import { Aperture, Bluetooth, Circle, Minus, Plus, ScanFace, Usb, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { activeRoute, pressRemote, usbReady, useBleState, useUsbState } from "../../lib/camera-remote.js";

const SPEEDS = ["1", "2", "3"] as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BTN =
    "no-drag flex min-h-10 select-none items-center justify-center gap-1.5 rounded-control px-3 py-2 text-xs font-medium outline-none transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45";

function HoldButton({ label, icon, disabled, onStart, onStop }: { label: string; icon: ReactNode; disabled: boolean; onStart: () => void; onStop: () => void }) {
    const [held, setHeld] = useState(false);
    const heldRef = useRef(false);
    const start = () => {
        if (heldRef.current || disabled) return;
        heldRef.current = true;
        setHeld(true);
        onStart();
    };
    const stop = () => {
        if (!heldRef.current) return;
        heldRef.current = false;
        setHeld(false);
        onStop();
    };
    const holdKey = (e: KeyboardEvent) => {
        if (e.key !== " " && e.key !== "Enter") return false;
        e.preventDefault();
        return true;
    };
    return (
        <button
            type="button"
            aria-pressed={held}
            disabled={disabled}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start();
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={(e) => {
                if (holdKey(e) && !e.repeat) start();
            }}
            onKeyUp={(e) => {
                if (holdKey(e)) stop();
            }}
            onBlur={stop}
            className={cn(BTN, held ? "bg-accent text-accent-fg" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent")}
        >
            {icon}
            {label}
        </button>
    );
}

/**
 * The camera remote outside the Studio (HUD popover and detached window):
 * zoom / focus holds, AF, photo, record; USB when TikSee holds a USB session,
 * Bluetooth otherwise (decision Q57).
 */
export function RemotePad({ settings, onPatch }: { settings: CameraRemoteSettings; onPatch: (p: Partial<CameraRemoteSettings>) => void }) {
    const { t } = useTranslation();
    const ble = useBleState();
    const usb = useUsbState();
    const route = activeRoute(settings.transport, ble, usb);
    const offline = route === null;
    const [busy, setBusy] = useState(false);

    const press = (action: RemoteAction, down: boolean) => {
        pressRemote(action, down, settings.speed, settings.transport).catch((e: unknown) => toast.error(errorText(e)));
    };
    const tap = (action: RemoteAction) => press(action, true);
    const hold = (action: RemoteAction, label: string, icon: ReactNode) => (
        <HoldButton label={label} icon={icon} disabled={offline} onStart={() => press(action, true)} onStop={() => press(action, false)} />
    );
    const usbCall = async (cmd: string, args?: Record<string, unknown>) => {
        setBusy(true);
        try {
            await invoke(cmd, args);
        } catch (e) {
            toast.error(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const bleTone = ble?.status === "connected" ? "success" : ble?.status === "error" ? "danger" : ble?.status === "pairable" ? "accent" : "neutral";
    const usbOn = usbReady(usb);
    const usbMode = usb?.mode ?? "off";

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                <StatusPill tone={bleTone} pulse={ble?.status === "searching"}>
                    <Bluetooth className="size-3" aria-hidden /> {t(`settings.studio.remote.status.${ble?.status ?? "searching"}`)}
                </StatusPill>
                <StatusPill tone={usbOn ? "success" : "neutral"}>
                    <Usb className="size-3" aria-hidden /> {usbOn ? t("cameraRemote.usbOn") : t("cameraRemote.usbOff")}
                </StatusPill>
                {ble?.recording === true && <StatusPill tone="danger">{t("settings.studio.remote.recording")}</StatusPill>}
                <span className="ml-auto text-[0.6875rem] text-fg-muted">
                    {route ? t("cameraRemote.via", { route: t(`cameraRemote.route.${route}`) }) : t("cameraRemote.offline")}
                </span>
            </div>

            {ble?.status !== "connected" && !usbOn && (
                <div className="flex flex-col gap-1.5 text-[0.6875rem] text-fg-muted">
                    <p>{t("cameraRemote.pairHint")}</p>
                    <button
                        type="button"
                        className={cn(BTN, "w-fit bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent")}
                        onClick={() => void invoke("camera_ble", { action: "pair", value: 0 }).catch((e: unknown) => toast.error(errorText(e)))}
                    >
                        <Bluetooth className="size-3.5" aria-hidden />
                        {t("settings.studio.remote.pair")}
                    </button>
                </div>
            )}

            <div className="grid grid-cols-2 gap-2">
                {hold("zoomOut", t("settings.studio.remote.zoomOut"), <ZoomOut className="size-4" aria-hidden />)}
                {hold("zoomIn", t("settings.studio.remote.zoomIn"), <ZoomIn className="size-4" aria-hidden />)}
                {hold("focusNear", t("settings.studio.remote.focusNear"), <Minus className="size-4" aria-hidden />)}
                {hold("focusFar", t("settings.studio.remote.focusFar"), <Plus className="size-4" aria-hidden />)}
            </div>
            <div className="grid grid-cols-3 gap-2">
                <button type="button" disabled={offline} onClick={() => tap("af")} className={cn(BTN, "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent")}>
                    <ScanFace className="size-4" aria-hidden />
                    {t("settings.studio.remote.af")}
                </button>
                <button type="button" disabled={offline} onClick={() => tap("photo")} className={cn(BTN, "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent")}>
                    <Aperture className="size-4" aria-hidden />
                    {t("settings.studio.remote.photo")}
                </button>
                <button
                    type="button"
                    disabled={offline}
                    aria-pressed={ble?.recording ?? false}
                    onClick={() => tap("record")}
                    className={cn(BTN, ble?.recording ? "bg-danger text-white" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent")}
                >
                    <Circle className={cn("size-4", !ble?.recording && "fill-danger text-danger")} aria-hidden />
                    {ble?.recording ? t("settings.studio.remote.stop") : t("settings.studio.remote.record")}
                </button>
            </div>

            <ChipSelector
                label={t("cameraRemote.speed")}
                options={SPEEDS}
                value={String(settings.speed) as (typeof SPEEDS)[number]}
                onSelect={(v) => onPatch({ speed: Number(v) })}
                display={(v) => `${v}×`}
            />
            <ChipSelector
                label={t("cameraRemote.transport")}
                options={CAMERA_TRANSPORTS}
                value={settings.transport}
                onSelect={(transport: CameraTransport) => onPatch({ transport })}
                display={(v) => t(`cameraRemote.transports.${v}`)}
            />

            <details className="rounded-control border border-border/60 px-2.5 py-2">
                <summary className="cursor-pointer text-xs font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("cameraRemote.usbTitle")}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                    <p className="text-[0.6875rem] text-warning">{t("cameraRemote.usbWarning")}</p>
                    <p className="text-[0.6875rem] text-fg-muted" aria-live="polite">
                        {usb?.probeFailed
                            ? t("studio.camera.exposure.status.probeFailed", { code: usb.probeFailed })
                            : t(`studio.camera.exposure.status.${usbMode}`)}
                        {usbOn && usb ? ` · ${usb.model}` : ""}
                    </p>
                    {usb?.error && usbMode !== "off" && <p className="text-[0.6875rem] text-fg-muted">{usb.error}</p>}
                    <div className="grid grid-cols-1 gap-1.5">
                        <button type="button" disabled={busy} className={cn(BTN, "bg-panel-alt text-fg hover:bg-accent-subtle")} onClick={() => void usbCall("camera_usb_start", { probe: true })}>
                            {t("studio.camera.exposure.connectProbe")}
                        </button>
                        <button type="button" disabled={busy} className={cn(BTN, "bg-panel-alt text-fg hover:bg-accent-subtle")} onClick={() => void usbCall("camera_usb_start", { probe: false })}>
                            {t("studio.camera.exposure.connectFull")}
                        </button>
                        {usbMode !== "off" && (
                            <button type="button" disabled={busy} className={cn(BTN, "bg-panel-alt text-fg hover:bg-accent-subtle")} onClick={() => void usbCall("camera_usb_stop")}>
                                {t("studio.camera.exposure.disconnect")}
                            </button>
                        )}
                    </div>
                </div>
            </details>
        </div>
    );
}
