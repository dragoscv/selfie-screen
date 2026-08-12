import {
    Moderator,
    emptySessionStats,
    eventDiamonds,
    type ChatEvent,
    type ConnectionStatus,
    type SessionStats,
    type Settings,
} from "@tiksee/core";

import { ConnectorSource } from "./ingest/connector.js";
import type { ChatSource, TikTokSession } from "./ingest/types.js";
import { logger } from "./logger.js";

const log = logger.scoped("[streams]");

/**
 * Events are flushed on a timer rather than individually. A gift storm can
 * produce 200 events/sec; one WebSocket frame + one React render per event
 * would melt the UI, whereas a 16ms batch aligns naturally with a frame.
 */
const FLUSH_INTERVAL_MS = 16;

export interface StreamSinks {
    onEvents: (events: ChatEvent[]) => void;
    onStatus: (status: ConnectionStatus) => void;
    onStats: (stats: SessionStats) => void;
    onAlert: (event: ChatEvent) => void;
}

interface StreamEntry {
    source: ChatSource;
    status: ConnectionStatus;
    stats: SessionStats;
    viewers: Set<string>;
    /** Last stats object handed to the UI, to suppress no-op broadcasts. */
    sentStats: SessionStats | null;
}

/**
 * Owns every active live connection and everything that must happen to an
 * event between ingestion and delivery: moderation, stats, alerts and
 * batching. Multi-stream is a first-class concept here — each connection is
 * keyed by `streamId` and is fully independent.
 */
export class StreamManager {
    #streams = new Map<string, StreamEntry>();
    #moderator: Moderator;
    #settings: Settings;
    #session: TikTokSession | null = null;
    #sinks: StreamSinks;

    #pending: ChatEvent[] = [];
    #flushTimer: NodeJS.Timeout | null = null;

    /** Extra taps (replay recorder, panel, OBS, voice) fed post-moderation. */
    #taps = new Set<(event: ChatEvent) => void>();

    constructor(settings: Settings, sinks: StreamSinks) {
        this.#settings = settings;
        this.#sinks = sinks;
        this.#moderator = new Moderator(settings.safety);
    }

    addTap(tap: (event: ChatEvent) => void): () => void {
        this.#taps.add(tap);
        return () => this.#taps.delete(tap);
    }

    setSettings(settings: Settings): void {
        this.#settings = settings;
        this.#moderator.setRules(settings.safety);
    }

    setSession(session: TikTokSession | null): void {
        this.#session = session;
    }

    get hasSession(): boolean {
        return this.#session !== null;
    }

    statuses(): ConnectionStatus[] {
        return [...this.#streams.values()].map((s) => s.status);
    }

    async connect(streamId: string, username: string, waitUntilLive: boolean): Promise<void> {
        const handle = username.trim().replace(/^@/, "");
        if (handle === "") throw new Error("A TikTok username is required");

        await this.disconnect(streamId);

        const entry: StreamEntry = {
            source: new ConnectorSource(),
            status: { streamId, username: handle, state: "connecting" },
            stats: emptySessionStats(streamId),
            viewers: new Set(),
            sentStats: null,
        };
        this.#streams.set(streamId, entry);
        this.#sinks.onStatus(entry.status);

        await entry.source.start(
            { streamId, username: handle, session: this.#session, waitUntilLive },
            {
                onEvent: (event) => this.ingest(event),
                onStatus: (patch) => {
                    const current = this.#streams.get(streamId);
                    if (!current) return;
                    current.status = { ...current.status, ...patch };
                    if (typeof patch.viewerCount === "number") {
                        current.stats.peakViewers = Math.max(current.stats.peakViewers, patch.viewerCount);
                    }
                    this.#sinks.onStatus(current.status);
                },
            },
        );
    }

    async disconnect(streamId: string): Promise<void> {
        const entry = this.#streams.get(streamId);
        if (!entry) return;
        this.#streams.delete(streamId);
        await entry.source.stop();
        this.#sinks.onStatus({ ...entry.status, state: "offline" });
        log.info(`disconnected ${streamId}`);
    }

    async disconnectAll(): Promise<void> {
        await Promise.all([...this.#streams.keys()].map((id) => this.disconnect(id)));
    }

    /**
     * The single entry point for every event, whatever produced it — a live
     * driver, the replay engine, or a simulated event from the UI. Moderation
     * and stats therefore apply uniformly.
     */
    ingest(event: ChatEvent): void {
        const verdict = this.#settings.safety.moderation
            ? this.#moderator.evaluate(event)
            : { blocked: false, alert: false as boolean };

        if (verdict.blocked) return;

        this.#tally(event);

        for (const tap of this.#taps) {
            try {
                tap(event);
            } catch (error) {
                log.warn("tap threw", error);
            }
        }

        if (verdict.alert) this.#sinks.onAlert(event);

        this.#pending.push(event);
        this.#scheduleFlush();
    }

    #tally(event: ChatEvent): void {
        const entry = this.#streams.get(event.streamId);
        if (!entry) return;
        // Replace rather than mutate: the object is serialised to the UI, where a
        // stable reference would be indistinguishable from "nothing changed".
        const stats = { ...entry.stats };

        switch (event.kind) {
            case "chat":
                stats.messages += 1;
                break;
            case "gift":
                stats.gifts += 1;
                stats.diamonds += eventDiamonds(event);
                break;
            case "follow":
                stats.follows += 1;
                break;
            case "join":
                stats.joins += 1;
                break;
            case "like":
                stats.likes += event.likeCount ?? 1;
                break;
            case "share":
                stats.shares += 1;
                break;
        }

        if (event.user.uniqueId !== "") {
            entry.viewers.add(event.user.uniqueId);
            stats.uniqueViewers = entry.viewers.size;
        }

        entry.stats = stats;
    }

    #scheduleFlush(): void {
        if (this.#flushTimer) return;
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    flush(): void {
        if (this.#pending.length > 0) {
            const batch = this.#pending;
            this.#pending = [];
            this.#sinks.onEvents(batch);
        }
        for (const entry of this.#streams.values()) {
            if (entry.sentStats === entry.stats) continue;
            entry.sentStats = entry.stats;
            this.#sinks.onStats(entry.stats);
        }
    }

    async dispose(): Promise<void> {
        if (this.#flushTimer) clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
        await this.disconnectAll();
    }
}
