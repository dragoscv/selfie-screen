import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { formatProp, type CameraState, type PropView, type UsbStatus } from "../../lib/camera-format.js";
import { FOCUS_RING } from "./context.js";
import { Section } from "./controls-parts.js";

/**
 * Real Sony exposure over USB PC Remote (lazy chunk inside the Camera dock panel).
 * "Keep HDMI" = probe handshake without SDIO GetExtDeviceInfo (decision Q43).
 */

const ROWS = ["iso", "shutterSpeed", "fNumber", "exposureBias", "whiteBalance", "colorTemp", "exposureMode"] as const;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const call = (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args).catch((e: unknown) => toast.error(errorText(e)));

const BUTTON = `rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-40 ${FOCUS_RING}`;

export function CameraExposureSection() {
    const { t } = useTranslation();
    const [state, setState] = useState<CameraState | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<CameraState>("camera://state", (e) => setState(e.payload)).then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
        });
        void invoke<UsbStatus>("camera_usb_status")
            .then((s) => {
                if (!disposed && s.state) setState(s.running ? s.state : { ...s.state, mode: "off" });
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const run = async (cmd: string, args?: Record<string, unknown>) => {
        setBusy(true);
        try {
            await call(cmd, args);
        } finally {
            setBusy(false);
        }
    };

    const mode = state?.mode ?? "off";
    const connected = state?.connected === true && mode !== "off";
    const status = state?.probeFailed
        ? t("studio.camera.exposure.status.probeFailed", { code: state.probeFailed })
        : t(`studio.camera.exposure.status.${mode}`);
    const props = new Map((state?.props ?? []).map((p) => [p.name, p]));

    return (
        <Section title={t("studio.camera.exposure.title")}>
            <p className="text-xs text-white" aria-live="polite">
                {status}
                {connected && state ? ` · ${state.model}` : ""}
            </p>
            {state?.error && mode !== "off" && <p className="text-[0.6875rem] text-amber-200">{state.error}</p>}
            <div className="grid grid-cols-1 gap-2">
                <button type="button" className={BUTTON} disabled={busy} onClick={() => void run("camera_usb_start", { probe: true })}>
                    {t("studio.camera.exposure.connectProbe")}
                </button>
                <button type="button" className={BUTTON} disabled={busy} onClick={() => void run("camera_usb_start", { probe: false })}>
                    {t("studio.camera.exposure.connectFull")}
                </button>
                {mode !== "off" && (
                    <button type="button" className={BUTTON} disabled={busy} onClick={() => void run("camera_usb_stop")}>
                        {t("studio.camera.exposure.disconnect")}
                    </button>
                )}
            </div>
            {connected && (
                <ul className="space-y-1.5">
                    {ROWS.map((name) => (
                        <ExposureRow key={name} label={t(`studio.camera.exposure.props.${name}`)} name={name} prop={props.get(name)} />
                    ))}
                </ul>
            )}
            <p className="text-[0.6875rem] text-white/70">{t("studio.camera.exposure.lookNote")}</p>
        </Section>
    );
}

function ExposureRow({ label, name, prop }: { label: string; name: string; prop: PropView | undefined }) {
    const { t } = useTranslation();
    const writable = prop?.writable === true && prop.enabled;
    const step = (dir: 1 | -1) => {
        if (prop) void call("camera_set_step", { code: prop.code, dir });
    };
    return (
        <li className="flex items-center gap-2">
            <span className="flex-1 text-xs text-white/80">{label}</span>
            <button
                type="button"
                className={`grid size-8 place-items-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-40 ${FOCUS_RING}`}
                disabled={!writable}
                aria-label={t("studio.camera.exposure.decrease", { name: label })}
                onClick={() => step(-1)}
            >
                <Minus className="size-4" aria-hidden />
            </button>
            <span className="w-24 text-center text-xs font-semibold tabular-nums text-white">{prop ? formatProp(name, prop.value) : "—"}</span>
            <button
                type="button"
                className={`grid size-8 place-items-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-40 ${FOCUS_RING}`}
                disabled={!writable}
                aria-label={t("studio.camera.exposure.increase", { name: label })}
                onClick={() => step(1)}
            >
                <Plus className="size-4" aria-hidden />
            </button>
        </li>
    );
}
