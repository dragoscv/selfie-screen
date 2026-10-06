import { Button, Card, StatusPill } from "@tiksee/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Usb } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** Mirrors `PropView` / `CameraState` in src-tauri/src/camera/mod.rs (event `camera://state`). */
interface PropView {
    code: number;
    name: string;
    writable: boolean;
    enabled: boolean;
    value: number | null;
    min: number | null;
    max: number | null;
    step: number | null;
    options: number[];
}

interface CameraState {
    transport: string;
    connected: boolean;
    model: string;
    firmware: string;
    error: string | null;
    props: PropView[];
}

/** Read-only or noisy properties shown as values, never as controls. */
const READ_ONLY = new Set(["battery", "focusFound", "movieRecording", "zoomPosition", "zoomScale"]);

const WB: Record<number, string> = {
    0x0002: "AWB",
    0x0004: "Daylight",
    0x0006: "Incandescent",
    0x0010: "Cloudy",
    0x0011: "Shade",
    0x0012: "C.Temp",
    0x8001: "Fluor. warm",
    0x8002: "Fluor. cool",
    0x8003: "Fluor. day white",
    0x8004: "Fluor. daylight",
    0x8030: "Underwater",
    0x8020: "Custom 1",
};

/** Sony SDIO value encodings (Camera Remote SDK docs). */
function formatProp(name: string, v: number | null): string {
    if (v === null) return "—";
    switch (name) {
        case "iso":
            return (v & 0xffffff) === 0xffffff ? "ISO AUTO" : `ISO ${v & 0xffffff}`;
        case "fNumber":
            return v === 0 || v === 0xfffe || v === 0xffff ? "F--" : `F${(v / 100).toFixed(1).replace(/\.0$/, "")}`;
        case "exposureBias": {
            const signed = v > 0x7fff ? v - 0x10000 : v;
            return `${signed > 0 ? "+" : ""}${(signed / 1000).toFixed(1)} EV`;
        }
        case "shutterSpeed": {
            if (v === 0) return "BULB";
            const num = Math.floor(v / 0x10000);
            const den = v & 0xffff;
            if (den === 0) return String(v);
            if (num === 1) return `1/${den}`;
            return `${(num / den).toFixed(num % den === 0 ? 0 : 1)}″`;
        }
        case "colorTemp":
            return `${v} K`;
        case "whiteBalance":
            return WB[v] ?? `0x${v.toString(16)}`;
        case "battery":
            return `${v}%`;
        default:
            return String(v);
    }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * USB PC Remote (WS26-02): full property access over PTP/SDIO. Opt-in, because the
 * ZV-E10 blanks its HDMI output for as long as the session is open (decision Q43).
 */
export function CameraUsb() {
    const { t } = useTranslation();
    const [state, setState] = useState<CameraState | null>(null);
    const [running, setRunning] = useState<boolean | null>(null);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<CameraState>("camera://state", (e) => {
            setState(e.payload);
            setRunning(true);
        }).then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
        });
        // camera_refresh fails with "camera control is not running" unless TIKSEE_CAMERA_CTL=usb.
        void invoke("camera_refresh")
            .then(() => {
                if (!disposed) setRunning(true);
            })
            .catch(() => {
                if (!disposed) setRunning(false);
            });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const refresh = useCallback(() => {
        void invoke("camera_refresh").catch((e: unknown) => toast.error(errorText(e)));
    }, []);

    const set = (code: number, value: number) => {
        void invoke("camera_set", { code, value }).catch((e: unknown) => toast.error(errorText(e)));
    };

    const connected = state?.connected === true;
    const known = (state?.props ?? []).filter((p) => p.name !== "");
    const controls = known.filter((p) => p.writable && !READ_ONLY.has(p.name) && (p.options.length > 0 || (p.min !== null && p.max !== null)));
    const readouts = known.filter((p) => !controls.includes(p));

    return (
        <Card title={t("settings.studio.usb.title")} subtitle={t("settings.studio.usb.hint")} icon={<Usb />} tint="var(--kind-chat)">
            <p className="rounded-chip bg-warning/15 px-2.5 py-1.5 text-[0.6875rem] text-warning">{t("settings.studio.usb.warning")}</p>

            {running === false ? (
                <div className="flex flex-col gap-1.5 text-xs text-fg-muted">
                    <p>{t("settings.studio.usb.disabled")}</p>
                    <code className="w-fit rounded bg-panel-alt px-2 py-1 text-[0.6875rem] text-fg">setx TIKSEE_CAMERA_CTL usb</code>
                    <p>{t("settings.studio.usb.disabledHint")}</p>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                        <StatusPill tone={connected ? "success" : state?.error ? "danger" : "neutral"} pulse={!connected}>
                            {connected ? t("settings.studio.usb.connected") : t("settings.studio.usb.searching")}
                        </StatusPill>
                        {connected && (
                            <span className="text-xs text-fg-muted">
                                {state.model} · fw {state.firmware}
                            </span>
                        )}
                        {state?.error && <span className="text-xs text-fg-muted">{state.error}</span>}
                        <Button size="sm" variant="ghost" icon={<RefreshCw />} className="ml-auto" onClick={refresh}>
                            {t("settings.studio.usb.refresh")}
                        </Button>
                    </div>
                    {!connected && <p className="text-xs text-fg-muted">{t("settings.studio.usb.steps")}</p>}
                    {connected && controls.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {controls.map((p) => (
                                <PropControl key={p.code} prop={p} label={t(`settings.studio.usb.props.${p.name}`, { defaultValue: p.name })} onSet={set} />
                            ))}
                        </div>
                    )}
                    {connected && readouts.length > 0 && (
                        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {readouts.map((p) => (
                                <div key={p.code} className="rounded-chip bg-panel-alt px-2.5 py-1.5">
                                    <dt className="text-[0.625rem] uppercase tracking-wide text-fg-muted">{t(`settings.studio.usb.props.${p.name}`, { defaultValue: p.name })}</dt>
                                    <dd className="text-xs font-semibold tabular-nums text-fg">{formatProp(p.name, p.value)}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                </>
            )}
        </Card>
    );
}

function PropControl({ prop, label, onSet }: { prop: PropView; label: string; onSet: (code: number, value: number) => void }) {
    const id = useId();
    const enumerated = prop.options.length > 0;
    const values = enumerated
        ? prop.options
        : rangeValues(prop.min ?? 0, prop.max ?? 0, prop.step && prop.step > 0 ? prop.step : 1);
    const options = prop.value !== null && !values.includes(prop.value) ? [prop.value, ...values] : values;
    return (
        <div className="space-y-1">
            <label htmlFor={id} className="block text-[0.6875rem] text-fg-muted">
                {label}
            </label>
            <select
                id={id}
                value={prop.value ?? ""}
                disabled={!prop.enabled}
                onChange={(e) => onSet(prop.code, Number(e.target.value))}
                className="no-drag h-10 w-full rounded-control border border-border bg-panel-alt px-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring/40 disabled:opacity-55"
            >
                {prop.value === null && <option value="">—</option>}
                {options.map((v) => (
                    <option key={v} value={v}>
                        {formatProp(prop.name, v)}
                    </option>
                ))}
            </select>
        </div>
    );
}

/** Range props (colour temperature) become a select; capped so a huge range stays usable. */
function rangeValues(min: number, max: number, step: number): number[] {
    const count = Math.floor((max - min) / step) + 1;
    const stride = count > 200 ? step * Math.ceil(count / 200) : step;
    const out: number[] = [];
    for (let v = min; v <= max; v += stride) out.push(v);
    return out;
}
