import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextEventId, type ChatEvent, type ChatKind } from "@tiksee/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_FACTS_PER_VIEWER, SCHEMA_VERSION, ViewerMemory } from "./db.js";

function ev(kind: ChatKind, uniqueId: string, extra: Partial<ChatEvent> = {}): ChatEvent {
    return {
        id: nextEventId(),
        kind,
        user: { id: uniqueId, uniqueId, nickname: uniqueId.toUpperCase() },
        text: kind === "chat" ? "salut" : kind,
        at: 1_000,
        streamId: "main",
        ...extra,
    };
}

describe("ViewerMemory", () => {
    let dir: string;
    let memory: ViewerMemory;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "tiksee-mem-"));
        memory = ViewerMemory.open(dir);
    });
    afterEach(() => {
        memory.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("migrates to the latest schema and is idempotent on reopen", () => {
        expect(memory.version).toBe(SCHEMA_VERSION);
        memory.addHighlight("moment");
        memory.close();
        memory = ViewerMemory.open(dir);
        expect(memory.version).toBe(SCHEMA_VERSION);
        expect(memory.count("highlights")).toBe(1);
    });

    it("counts a visit once per session per viewer", () => {
        const s1 = memory.startSession("creator");
        const first = memory.observe(ev("join", "ana"), s1);
        expect(first).toEqual({ before: null, firstThisSession: true });
        const again = memory.observe(ev("chat", "ana"), s1);
        expect(again.firstThisSession).toBe(false);
        memory.observe(ev("chat", "ana"), s1);
        expect(memory.person("ana")).toMatchObject({ visits: 1, messages: 2 });

        memory.endSession(s1, { messages: 2 });
        const s2 = memory.startSession("creator");
        const back = memory.observe(ev("chat", "ana", { at: 9_000 }), s2);
        expect(back.firstThisSession).toBe(true);
        expect(back.before).toMatchObject({ visits: 1 });
        expect(memory.person("ana")).toMatchObject({ visits: 2, messages: 3, firstSeen: 1_000, lastSeen: 9_000 });
    });

    it("sums gift diamonds and remembers followers", () => {
        const s = memory.startSession("creator");
        memory.observe(ev("gift", "ion", { giftDiamonds: 5, giftCount: 3 }), s);
        memory.observe(ev("follow", "ion"), s);
        expect(memory.person("ion")).toMatchObject({ totalDiamonds: 15, follower: true });
    });

    it("never writes replay or out-of-session events and honours persistHistory", () => {
        const s = memory.startSession("creator");
        memory.observe(ev("chat", "ghost", { replay: true }), s);
        expect(memory.person("ghost")).toBeNull();
        memory.observe(ev("chat", "demo"), null);
        expect(memory.person("demo")).toBeNull();
        expect(memory.count("events")).toBe(0);

        memory.persistHistory = false;
        memory.observe(ev("chat", "real"), s);
        expect(memory.person("real")).not.toBeNull();
        expect(memory.count("events")).toBe(0);

        memory.persistHistory = true;
        memory.observe(ev("chat", "real"), s);
        expect(memory.count("events")).toBe(1);
    });

    it("keeps at most 20 facts per viewer, newest first", () => {
        const facts = Array.from({ length: 25 }, (_, i) => `fact ${i}`);
        memory.observe(ev("chat", "ana"), memory.startSession("creator"));
        memory.addFacts("ana", facts, 100);
        const stored = memory.facts("ana");
        expect(stored).toHaveLength(MAX_FACTS_PER_VIEWER);
        expect(stored[0]).toBe("fact 24");
        expect(stored).not.toContain("fact 0");
        expect(memory.card("ana")?.facts).toHaveLength(5);
    });

    it("prunes old sessions and events by retention", () => {
        const now = 400 * 86_400_000;
        const old = memory.startSession("creator", 1);
        memory.observe(ev("chat", "ana", { at: 1 }), old);
        const fresh = memory.startSession("creator", now - 1000);
        memory.observe(ev("chat", "ana", { at: now - 1000 }), fresh);
        expect(memory.prune(365, now)).toBe(1);
        expect(memory.count("sessions")).toBe(1);
        expect(memory.count("events")).toBe(1);
        expect(memory.prune(0, now)).toBe(0);
    });
});
