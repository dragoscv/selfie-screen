import { invoke, isTauri } from "@tauri-apps/api/core";
import type { VocalParams, VocalSettings } from "@tiksee/core";

/** Shell status (`vocal_status` in src-tauri/src/vocal_host.rs). */
export interface VocalStatus {
    available: boolean;
    vmType: number;
    running: boolean;
    micStrip: number;
    musicStrip: number;
    sampleRate: number;
    block: number;
    conflict: string | null;
    error: string | null;
    callbacks: number;
    channelPeaksDb: number[];
}

/** 60 Hz meter snapshot from the audio thread. */
export interface VocalMeter {
    running: boolean;
    inputDb: number;
    outputDb: number;
    detectedMidi: number;
    targetMidi: number;
    correctedMidi: number;
    voiced: boolean;
    clarity: number;
    compReductionDb: number;
    deessReductionDb: number;
    duckGainDb: number;
    latencyMs: number;
    /** [key 0-11, minor, confidence] from the music strip. */
    key: [number, boolean, number] | null;
    /** What the audio thread is using now (proves settings arrived). */
    activeKey: number;
    activeScale: string;
    activeMode: string;
    tuneOn: boolean;
}

export interface StripInfo {
    index: number;
    device: string;
    label: string;
}

/** Index = the host's mic channel code (0 left, 1 right, 2 both). */
export const MIC_CHANNELS = ["left", "right", "both"] as const;

export const activeParams = (v: VocalSettings): VocalParams => (v.slot === "b" && v.paramsB ? v.paramsB : v.params);

let started: string | null = null;
let lastParams = "";

/**
 * Starts/stops the engine and pushes parameters. Called by the main window on
 * every vocal settings change; idempotent and cheap when nothing changed.
 */
export async function syncVocalEngine(v: VocalSettings): Promise<void> {
    if (!isTauri()) return;
    const params = JSON.stringify(activeParams(v));
    if (params !== lastParams) {
        lastParams = params;
        await invoke("vocal_set_params", { params: JSON.parse(params) as unknown }).catch((e: unknown) => console.error("[vocal] params", e));
    }
    const want = v.enabled ? `${v.micStrip}:${v.musicStrip}:${v.micChannel}` : null;
    if (want === started) return;
    if (want === null) {
        await invoke("vocal_stop").catch(() => undefined);
        started = null;
        return;
    }
    try {
        await invoke("vocal_start", { micStrip: v.micStrip, musicStrip: v.musicStrip, micChannel: MIC_CHANNELS.indexOf(v.micChannel) });
        started = want;
    } catch (e) {
        started = null;
        console.error("[vocal] start", e);
    }
}

export function openVocalWindow(onTop: boolean): Promise<void> {
    return invoke<void>("toggle_vocal_window", { show: true, onTop });
}
