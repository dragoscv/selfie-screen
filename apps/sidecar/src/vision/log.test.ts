import type { SignalEvent, SignalId } from "@tiksee/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerMemory } from "../memory/db.js";
import { VisionLog } from "./log.js";

const DAY = 86_400_000;

function ev(signal: SignalId, phase: SignalEvent["phase"], at: number, extra: Partial<SignalEvent> = {}): SignalEvent {
    return { signal, phase, at, confidence: 0.8, subject: { kind: "person", track: 0, owner: true, name: "Dragos" }, ...extra };
}

describe("VisionLog", () => {
    let memory: ViewerMemory;
    let now: number;
    let log: VisionLog;

    beforeEach(() => {
        memory = ViewerMemory.open(":memory:");
        now = 10 * DAY;
        log = new VisionLog({ db: memory.raw, now: () => now, sessionId: () => memory.activeSessionId() });
    });
    afterEach(() => {
        vi.useRealTimers();
        memory.close();
    });

    it("records a start/end interval with its duration", () => {
        log.record([ev("smile", "start", now), ev("smile", "end", now + 2500, { durationMs: 2500 })]);
        const { entries } = log.query();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ signal: "smile", startedAt: now, durationMs: 2500, owner: true, subjectKind: "person", subjectName: "Dragos" });
    });

    it("derives the duration from the start edge when end carries none", () => {
        log.record([ev("talking", "start", now), ev("talking", "end", now + 900)]);
        expect(log.query().entries[0]?.durationMs).toBe(900);
    });

    it("records pulses with zero duration and keeps open starts in memory", () => {
        log.record([ev("wink_left", "pulse", now), ev("smile", "start", now)]);
        const { entries } = log.query();
        expect(entries.map((e) => [e.signal, e.durationMs])).toEqual([["wink_left", 0]]);
    });

    it("tracks subjects separately", () => {
        const dog = { kind: "dog" as const, track: 3, owner: false, name: "Kiri" };
        log.record([ev("smile", "start", now), ev("smile", "start", now + 100, { subject: dog }), ev("smile", "end", now + 1000)]);
        const { entries } = log.query();
        expect(entries).toHaveLength(1);
        expect(entries[0]?.subjectKind).toBe("person");
    });

    it("computes stats per signal", () => {
        log.record([
            ev("smile", "end", now + 1000, { durationMs: 1000 }),
            ev("smile", "end", now + 5000, { durationMs: 3000 }),
            ev("nod", "pulse", now),
        ]);
        const { stats } = log.query();
        expect(stats.find((s) => s.signal === "smile")).toEqual({ signal: "smile", count: 2, totalMs: 4000, longestMs: 3000 });
        expect(stats.find((s) => s.signal === "nod")).toEqual({ signal: "nod", count: 1, totalMs: 0, longestMs: 0 });
    });

    it("filters by since, signal and limit", () => {
        log.record([ev("nod", "pulse", now - 5000), ev("nod", "pulse", now), ev("shake", "pulse", now), ev("nod", "pulse", now + 1)]);
        expect(log.query({ sinceMs: now }).entries).toHaveLength(3);
        expect(log.query({ signal: "nod" }).entries).toHaveLength(3);
        expect(log.query({ signal: "nod", limit: 1 }).entries[0]?.startedAt).toBe(now + 1);
    });

    it("links rows to the active session", () => {
        const id = memory.startSession("creator", now);
        log.record([ev("nod", "pulse", now)]);
        expect(log.query().entries[0]?.sessionId).toBe(id);
    });

    it("batches writes and flushes after one second", async () => {
        vi.useFakeTimers();
        log.record([ev("nod", "pulse", now)]);
        const count = () => Number((memory.raw.prepare("SELECT COUNT(*) AS n FROM vision_events").get() as { n: number }).n);
        expect(count()).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(count()).toBe(1);
    });

    it("flushes open intervals with their duration so far on close", () => {
        log.record([ev("talking", "start", now)]);
        now += 4000;
        log.close();
        const rows = memory.raw.prepare("SELECT signal, duration_ms FROM vision_events").all() as { signal: string; duration_ms: number }[];
        expect(rows).toEqual([{ signal: "talking", duration_ms: 4000 }]);
    });

    it("prunes rows older than the retention window", () => {
        log.record([ev("nod", "pulse", now - 40 * DAY + DAY * 5), ev("nod", "pulse", now - 3 * DAY)]);
        log.flush();
        log.setRetention(30);
        expect(log.query().entries).toHaveLength(1);
        log.close();
    });

    it("ignores events while disabled, and clears", () => {
        log.enabled = false;
        log.record([ev("nod", "pulse", now)]);
        expect(log.query().entries).toHaveLength(0);
        log.enabled = true;
        log.record([ev("nod", "pulse", now)]);
        expect(log.clear()).toBe(0);
        log.record([ev("nod", "pulse", now)]);
        log.flush();
        expect(log.clear()).toBe(1);
        expect(log.query().entries).toHaveLength(0);
    });
});
