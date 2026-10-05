import {
    defaultSettings,
    emptySessionStats,
    liveControlStateSchema,
    parseSettings,
    type ChatEvent,
    type ConnectionStatus,
    type EffectFired,
    type GameState,
    type GoalsState,
    type LiveControlState,
    type PanelStatus,
    type ReplayInfo,
    type ReplyItem,
    type SerialPortInfo,
    type ServerMessage,
    type SessionInfo,
    type SessionStats,
    type SessionSummary,
    type Settings,
    type Suggestion,
    type ViewerCard,
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

export type MicState = "off" | "starting" | "connecting" | "live" | "reconnecting" | "error";

export interface TranscriptLine {
    itemId: string;
    text: string;
    at: number;
}

export interface TranscriptState {
    mic: MicState;
    /** Energy VAD: the streamer is talking right now. */
    speaking: boolean;
    /** Push-to-talk latch (only consulted when assistant.pushToTalk is on). */
    pushToTalk: boolean;
    partial: string;
    finals: TranscriptLine[];
    error: string | null;
}

/** What the co-host is saying right now. */
export interface SpeakingState {
    id: string;
    text: string;
    eventId?: string;
}

/** A returning-viewer card queued for display, with a unique key. */
export interface QueuedViewerCard {
    key: string;
    card: ViewerCard;
}

/** Inline Romanian translation of a chat line (WS20-14). */
export interface Translation {
    lang: string;
    text: string;
}

export interface SummaryState {
    sessions: SessionInfo[];
    current: SessionSummary | null;
    loading: boolean;
    error: string | null;
    /** The summary dialog is open. */
    open: boolean;
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
    speaking: SpeakingState | null;

    /* live studio */
    liveControl: LiveControlState;
    replyQueue: ReplyItem[];
    suggestions: Suggestion[];
    viewerCards: QueuedViewerCard[];
    effects: EffectFired[];
    transcript: TranscriptState;
    goals: GoalsState;
    game: GameState;
    translations: Record<string, Translation>;
    summary: SummaryState;

    /* diagnostics */
    logs: LogLine[];

    /* actions */
    handleMessage: (message: ServerMessage) => void;
    setSidecarConnected: (connected: boolean) => void;
    setSidecarError: (error: string | null) => void;
    setHasTikTokSession: (has: boolean) => void;
    updateSettings: (patch: (current: Settings) => Settings) => void;
    hydrateSettings: (raw: unknown) => void;
    clearEvents: (streamId: string) => void;
    setSpeaking: (speaking: SpeakingState | null) => void;
    dismissSuggestion: (id: string) => void;
    dismissViewerCard: (key: string) => void;
    patchTranscript: (patch: Partial<Omit<TranscriptState, "finals">>) => void;
    addTranscriptFinal: (line: TranscriptLine) => void;
    /** Ask the sidecar for a session summary and open the dialog. */
    openSummary: (sessionId?: number) => void;
    closeSummary: () => void;
}

const MAX_LOGS = 300;
const MAX_SUGGESTIONS = 5;
const MAX_EFFECTS = 10;
const MAX_FINALS = 5;
const MAX_CARDS = 6;
/** Translations are keyed by event id; keep roughly one feed's worth. */
const MAX_TRANSLATIONS = 600;

const INITIAL_SUMMARY: SummaryState = { sessions: [], current: null, loading: false, error: null, open: false };

const INITIAL_TRANSCRIPT: TranscriptState = {
    mic: "off",
    speaking: false,
    pushToTalk: false,
    partial: "",
    finals: [],
    error: null,
};

let cardSeq = 0;

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
    speaking: null,

    liveControl: liveControlStateSchema.parse({}),
    replyQueue: [],
    suggestions: [],
    viewerCards: [],
    effects: [],
    transcript: INITIAL_TRANSCRIPT,
    goals: { enabled: false, overlay: false, goals: [] },
    game: { kind: "none" },
    translations: {},
    summary: INITIAL_SUMMARY,

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
                // Non-fatal failures are toasts (see useSidecarErrorToasts);
                // only a fatal one deserves the persistent banner.
                if (message.fatal) set({ sidecarError: message.message });
                break;

            case "liveControl":
                set({ liveControl: message.state });
                break;

            case "replyQueue":
                set({ replyQueue: message.items });
                break;

            case "suggestion":
                set((state) => ({
                    suggestions: [
                        message.suggestion,
                        ...state.suggestions.filter((s) => s.id !== message.suggestion.id),
                    ].slice(0, MAX_SUGGESTIONS),
                }));
                break;

            case "viewerCard":
                set((state) => ({
                    viewerCards: [
                        ...state.viewerCards.filter((c) => c.card.uniqueId !== message.card.uniqueId),
                        { key: `${message.card.uniqueId}-${++cardSeq}`, card: message.card },
                    ].slice(-MAX_CARDS),
                }));
                break;

            case "effect":
                set((state) => ({ effects: [message.effect, ...state.effects].slice(0, MAX_EFFECTS) }));
                break;

            case "goals":
                set({ goals: message.state });
                break;

            case "game":
                set({ game: message.state });
                break;

            case "translation":
                set((state) => {
                    const next = { ...state.translations, [message.eventId]: { lang: message.lang, text: message.text } };
                    const keys = Object.keys(next);
                    if (keys.length > MAX_TRANSLATIONS) {
                        for (const key of keys.slice(0, keys.length - MAX_TRANSLATIONS)) delete next[key];
                    }
                    return { translations: next };
                });
                break;

            case "summaries":
                set((state) => ({ summary: { ...state.summary, sessions: message.sessions } }));
                break;

            case "summary":
                set((state) => ({
                    summary: {
                        ...state.summary,
                        current: message.summary ?? state.summary.current,
                        loading: false,
                        error: message.error ?? null,
                        // A session that just ended opens the review on its own.
                        open: state.summary.open || (message.auto && message.summary !== undefined),
                    },
                }));
                break;

            default:
                break;
        }
    },

    setSidecarConnected: (connected) => set({ sidecarConnected: connected }),
    setSidecarError: (error) => set({ sidecarError: error }),
    setHasTikTokSession: (has) => set({ hasTikTokSession: has }),

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

    setSpeaking: (speaking) => set({ speaking, speakingEventId: speaking?.eventId ?? null }),

    dismissSuggestion: (id) =>
        set((state) => ({ suggestions: state.suggestions.filter((s) => s.id !== id) })),

    dismissViewerCard: (key) =>
        set((state) => ({ viewerCards: state.viewerCards.filter((c) => c.key !== key) })),

    patchTranscript: (patch) => set((state) => ({ transcript: { ...state.transcript, ...patch } })),

    addTranscriptFinal: (line) =>
        set((state) => ({
            transcript: {
                ...state.transcript,
                partial: "",
                finals: [...state.transcript.finals.filter((f) => f.itemId !== line.itemId), line].slice(
                    -MAX_FINALS,
                ),
            },
        })),

    openSummary: (sessionId) => {
        set((state) => ({ summary: { ...state.summary, open: true, loading: true, error: null } }));
        sidecarClient.send({ type: "summaryList" });
        sidecarClient.send(sessionId === undefined ? { type: "summaryRequest" } : { type: "summaryRequest", sessionId });
    },

    closeSummary: () => set((state) => ({ summary: { ...state.summary, open: false } })),
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
