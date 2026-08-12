import {
    defaultSettings,
    emptySessionStats,
    parseSettings,
    type ChatEvent,
    type ConnectionStatus,
    type PanelStatus,
    type ReplayInfo,
    type SerialPortInfo,
    type ServerMessage,
    type SessionStats,
    type Settings,
} from "@tiksee/core";
import { create } from "zustand";

import { sidecarClient } from "../lib/sidecar-client.js";

/** The primary stream id. Multi-stream adds more keyed by handle. */
export const MAIN_STREAM = "main";

export interface LogLine {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    at: number;
}

interface AppState {
    /* connection to our own sidecar (not to TikTok) */
    sidecarConnected: boolean;
    sidecarError: string | null;
    overlayPort: number;
    hasTikTokSession: boolean;

    /* live data, keyed by stream */
    events: Record<string, ChatEvent[]>;
    statuses: Record<string, ConnectionStatus>;
    stats: Record<string, SessionStats>;

    /* settings */
    settings: Settings;
    settingsLoaded: boolean;

    /* peripherals */
    panel: PanelStatus;
    panelPorts: SerialPortInfo[];
    panelPreview: string | null;

    /* replay */
    replays: ReplayInfo[];
    replayPlaying: boolean;
    replayRecording: boolean;
    replayProgress: number;

    /* OBS */
    obsConnected: boolean;
    obsError: string | null;
    obsScenes: string[];
    obsScene: string;

    /* voice */
    speakingEventId: string | null;
    speechQueued: number;

    /* diagnostics */
    logs: LogLine[];

    /* actions */
    handleMessage: (message: ServerMessage) => void;
    setSidecarConnected: (connected: boolean) => void;
    setSidecarError: (error: string | null) => void;
    updateSettings: (patch: (current: Settings) => Settings) => void;
    hydrateSettings: (raw: unknown) => void;
    clearEvents: (streamId: string) => void;
    setSpeaking: (eventId: string | null, queued: number) => void;
}

const MAX_LOGS = 300;

export const useAppStore = create<AppState>((set, get) => ({
    sidecarConnected: false,
    sidecarError: null,
    overlayPort: 0,
    hasTikTokSession: false,

    events: {},
    statuses: {},
    stats: {},

    settings: defaultSettings(),
    settingsLoaded: false,

    panel: { connected: false, fps: 0, frames: 0 },
    panelPorts: [],
    panelPreview: null,

    replays: [],
    replayPlaying: false,
    replayRecording: false,
    replayProgress: 0,

    obsConnected: false,
    obsError: null,
    obsScenes: [],
    obsScene: "",

    speakingEventId: null,
    speechQueued: 0,

    logs: [],

    handleMessage: (message) => {
        switch (message.type) {
            case "hello":
                set({
                    overlayPort: message.overlayPort,
                    hasTikTokSession: message.hasSession,
                    sidecarError: null,
                });
                // The sidecar starts with defaults; push ours so it agrees with the UI.
                sidecarClient.send({ type: "settings", settings: get().settings });
                break;

            case "events": {
                const cap = get().settings.display.maxFeedEvents;
                set((state) => {
                    const next = { ...state.events };
                    for (const event of message.events) {
                        const list = next[event.streamId] ?? [];
                        const appended = list.length >= cap ? [...list.slice(list.length - cap + 1), event] : [...list, event];
                        next[event.streamId] = appended;
                    }
                    return { events: next };
                });
                break;
            }

            case "status":
                set((state) => ({
                    statuses: { ...state.statuses, [message.status.streamId]: message.status },
                }));
                break;

            case "stats":
                set((state) => ({
                    stats: { ...state.stats, [message.stats.streamId]: message.stats },
                }));
                break;

            case "panelStatus":
                set({ panel: message.status });
                break;
            case "panelPorts":
                set({ panelPorts: message.ports });
                break;
            case "panelPreview":
                set({ panelPreview: message.dataUrl });
                break;

            case "replays":
                set({ replays: message.replays });
                break;

            case "obsStatus":
                // Previously fell through to `default`, so a failed connect
                // looked identical to a successful one.
                set({ obsConnected: message.connected, obsError: message.error ?? null });
                break;
            case "obsScenes":
                set({ obsScenes: message.scenes, obsScene: message.current });
                break;

            case "replayStatus":
                set({
                    replayPlaying: message.playing,
                    replayRecording: message.recording,
                    replayProgress: message.progress,
                });
                break;

            case "log":
                set((state) => {
                    const logs = [...state.logs, message];
                    return { logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs };
                });
                break;

            case "error":
                set({ sidecarError: message.message });
                break;

            default:
                break;
        }
    },

    setSidecarConnected: (connected) => set({ sidecarConnected: connected }),
    setSidecarError: (error) => set({ sidecarError: error }),

    updateSettings: (patch) => {
        const next = patch(get().settings);
        set({ settings: next });
        // The sidecar owns hardware and network, so it must hear about every
        // change immediately; persistence is handled by the settings hook.
        sidecarClient.send({ type: "settings", settings: next });
    },

    hydrateSettings: (raw) => {
        const settings = parseSettings(raw);
        set({ settings, settingsLoaded: true });
        sidecarClient.send({ type: "settings", settings });
    },

    clearEvents: (streamId) =>
        set((state) => ({
            events: { ...state.events, [streamId]: [] },
            stats: { ...state.stats, [streamId]: emptySessionStats(streamId) },
        })),

    setSpeaking: (eventId, queued) => set({ speakingEventId: eventId, speechQueued: queued }),
}));

/* ------------------------------------------------------------------ *
 * Selectors — keep components subscribed to the narrowest slice.
 *
 * Every selector MUST return a referentially stable value for unchanged
 * state. zustand compares with Object.is, so returning a freshly built
 * fallback object each call makes useSyncExternalStore believe the store
 * changed on every render and loops forever. Hence the per-stream caches.
 * ------------------------------------------------------------------ */

const EMPTY_EVENTS: ChatEvent[] = [];
const fallbackStatuses = new Map<string, ConnectionStatus>();
const fallbackStats = new Map<string, SessionStats>();

function offlineStatus(streamId: string): ConnectionStatus {
    let status = fallbackStatuses.get(streamId);
    if (!status) {
        status = { streamId, username: "", state: "offline" };
        fallbackStatuses.set(streamId, status);
    }
    return status;
}

function zeroStats(streamId: string): SessionStats {
    let stats = fallbackStats.get(streamId);
    if (!stats) {
        stats = emptySessionStats(streamId, 0);
        fallbackStats.set(streamId, stats);
    }
    return stats;
}

export const selectEvents = (streamId: string) => (state: AppState) =>
    state.events[streamId] ?? EMPTY_EVENTS;

export const selectStatus =
    (streamId: string) =>
        (state: AppState): ConnectionStatus =>
            state.statuses[streamId] ?? offlineStatus(streamId);

export const selectStats =
    (streamId: string) =>
        (state: AppState): SessionStats =>
            state.stats[streamId] ?? zeroStats(streamId);
