import { defaultSettings, nextEventId, type ChatEvent, type ChatKind } from "@tiksee/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StreamManager } from "./streams.js";

function ev(kind: ChatKind, nickname: string, text = "hello", extra: Partial<ChatEvent> = {}): ChatEvent {
    return {
        id: nextEventId(),
        kind,
        user: { id: nickname, uniqueId: nickname.toLowerCase(), nickname },
        text,
        at: Date.now(),
        streamId: "main",
        ...extra,
    };
}

function makeManager(overrides: Partial<ReturnType<typeof defaultSettings>> = {}) {
    const settings = { ...defaultSettings(), ...overrides };
    const onEvents = vi.fn();
    const onStatus = vi.fn();
    const onStats = vi.fn();
    const onAlert = vi.fn();
    const manager = new StreamManager(settings, { onEvents, onStatus, onStats, onAlert });
    return { manager, onEvents, onStatus, onStats, onAlert, settings };
}

describe("StreamManager", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it("batches events rather than emitting one frame each", () => {
        const { manager, onEvents } = makeManager();
        manager.ingest(ev("chat", "Ana"));
        manager.ingest(ev("chat", "Mihai"));
        manager.ingest(ev("chat", "Ion"));

        // Nothing is delivered until the flush window elapses.
        expect(onEvents).not.toHaveBeenCalled();

        manager.flush();
        expect(onEvents).toHaveBeenCalledTimes(1);
        expect(onEvents.mock.calls[0]?.[0]).toHaveLength(3);
    });

    it("delivers moderated events to every registered tap", () => {
        const { manager } = makeManager();
        const tap = vi.fn();
        manager.addTap(tap);

        manager.ingest(ev("chat", "Ana"));
        expect(tap).toHaveBeenCalledTimes(1);
    });

    it("stops removing a tap once it is disposed", () => {
        const { manager } = makeManager();
        const tap = vi.fn();
        const remove = manager.addTap(tap);

        manager.ingest(ev("chat", "Ana"));
        remove();
        manager.ingest(ev("chat", "Mihai"));

        expect(tap).toHaveBeenCalledTimes(1);
    });

    it("blocks a moderated word before it reaches taps or the UI", () => {
        const settings = defaultSettings();
        settings.safety.blockedWords = ["forbidden"];
        const { manager, onEvents } = makeManager(settings);
        const tap = vi.fn();
        manager.addTap(tap);

        manager.ingest(ev("chat", "Spammer", "this is forbidden"));
        manager.flush();

        expect(tap).not.toHaveBeenCalled();
        expect(onEvents).not.toHaveBeenCalled();
    });

    it("raises an alert for a keyword without blocking the message", () => {
        const settings = defaultSettings();
        settings.safety.alertKeywords = ["giveaway"];
        const { manager, onAlert } = makeManager(settings);
        const tap = vi.fn();
        manager.addTap(tap);

        manager.ingest(ev("chat", "Ana", "when is the giveaway?"));

        expect(onAlert).toHaveBeenCalledTimes(1);
        expect(tap).toHaveBeenCalledTimes(1);
    });

    it("bypasses moderation entirely when it is switched off", () => {
        const settings = defaultSettings();
        settings.safety.moderation = false;
        settings.safety.blockedWords = ["forbidden"];
        const { manager } = makeManager(settings);
        const tap = vi.fn();
        manager.addTap(tap);

        manager.ingest(ev("chat", "Ana", "this is forbidden"));
        expect(tap).toHaveBeenCalledTimes(1);
    });

    it("survives a throwing tap without losing the event", () => {
        const { manager, onEvents } = makeManager();
        manager.addTap(() => {
            throw new Error("tap exploded");
        });
        const healthy = vi.fn();
        manager.addTap(healthy);

        expect(() => manager.ingest(ev("chat", "Ana"))).not.toThrow();
        manager.flush();

        expect(healthy).toHaveBeenCalledTimes(1);
        expect(onEvents).toHaveBeenCalledTimes(1);
    });

    it("reports no statuses before anything connects", () => {
        const { manager } = makeManager();
        expect(manager.statuses()).toEqual([]);
    });

    it("tracks the session only for known streams", () => {
        const { manager, onStats } = makeManager();
        // Ingesting for a stream that was never connected must not throw.
        expect(() => manager.ingest(ev("gift", "Ana", "sent a Rose"))).not.toThrow();
        manager.flush();
        expect(onStats).not.toHaveBeenCalled();
    });

    it("exposes whether a TikTok session is stored", () => {
        const { manager } = makeManager();
        expect(manager.hasSession).toBe(false);
        manager.setSession({ sessionId: "x", ttTargetIdc: "useast1a" });
        expect(manager.hasSession).toBe(true);
        manager.setSession(null);
        expect(manager.hasSession).toBe(false);
    });

    it("rejects an empty username", async () => {
        const { manager } = makeManager();
        await expect(manager.connect("main", "   ", false)).rejects.toThrow();
    });
});
