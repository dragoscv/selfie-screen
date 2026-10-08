/** Mirrors `PropView` / `CameraState` in src-tauri/src/camera/mod.rs (event `camera://state`). */
export interface PropView {
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

export type CameraMode = "off" | "full" | "probe";

export interface CameraState {
    transport: string;
    mode: CameraMode;
    connected: boolean;
    model: string;
    firmware: string;
    error: string | null;
    /** Probe mode: PTP response code when the camera refused SDIO without 0x9202. */
    probeFailed: string | null;
    props: PropView[];
}

export interface UsbStatus {
    running: boolean;
    mode: CameraMode;
    state: CameraState | null;
}

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

const EXPOSURE_MODE: Record<number, string> = {
    0x0001: "M",
    0x0002: "P",
    0x0003: "A",
    0x0004: "S",
    0x8000: "iAuto",
    0x8001: "Superior Auto",
    0x8050: "Movie P",
    0x8051: "Movie A",
    0x8052: "Movie S",
    0x8053: "Movie M",
};

/** Sony SDIO value encodings (Camera Remote SDK docs). */
export function formatProp(name: string, v: number | null): string {
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
        case "exposureMode":
            return EXPOSURE_MODE[v] ?? `0x${v.toString(16)}`;
        case "battery":
            return `${v}%`;
        default:
            return String(v);
    }
}
