import { describe, expect, it } from "vitest";

import { buildSummary, csvField, findSpikes, summaryToCsv, summaryToJson, type StoredEvent } from "./summary.js";

const START = Date.UTC(2026, 9, 5, 18, 0, 0);
const MIN = 60_000;

function ev(kind: string, uniqueId: string, at: number, extra: Partial<StoredEvent> = {}): StoredEvent {
    return { kind, uniqueId, nickname: uniqueId.toUpperCase(), text: kind, at: START + at, diamonds: 0, ...extra };
}

describe("findSpikes", () => {
    it("returns minutes at least twice the median and above the floor", () => {
        expect(findSpikes([4, 5, 30, 4, 12, 5])).toEqual([
            { minute: 2, messages: 30 },
            { minute: 4, messages: 12 },
        ]);
        expect(findSpikes([2, 3, 7])).toEqual([]);
        expect(findSpikes([])).toEqual([]);
    });
});

describe("buildSummary", () => {
    const events: StoredEvent[] = [
        ev("join", "ana", 1_000),
        ev("chat", "ana", 2_000),
        ev("gift", "ion", 3_000, { diamonds: 500, text: "a trimis Lion" }),
        ev("gift", "ana", 4_000, { diamonds: 5 }),
        ev("follow", "ion", 5_000),
        ...Array.from({ length: 20 }, (_, i) => ev("chat", `v${i % 4}`, 2 * MIN + i * 100)),
        ev("chat", "ana", 3 * MIN),
    ];
    const summary = buildSummary(
        { id: 7, username: "creator", startedAt: START, endedAt: START + 4 * MIN },
        events,
        [{ at: START + 90_000, note: "ana: ce tare" }],
        { likes: 1234, peakViewers: 88, messages: 1 },
    );

    it("computes duration, stats and a per-minute timeline", () => {
        expect(summary.durationMs).toBe(4 * MIN);
        expect(summary.timeline).toHaveLength(4);
        expect(summary.timeline[2]?.messages).toBe(20);
        expect(summary.timeline[0]?.diamonds).toBe(505);
        expect(summary.stats).toMatchObject({ messages: 22, gifts: 2, diamonds: 505, follows: 1, joins: 1, likes: 1234, peakViewers: 88 });
    });

    it("orders moments by time and includes gifts, highlights and spikes", () => {
        expect(summary.moments.map((m) => m.kind)).toEqual(["gift", "gift", "highlight", "spike"]);
        expect(summary.moments[0]).toMatchObject({ title: "ION", value: 500 });
        expect(summary.moments[3]).toMatchObject({ value: 20, at: START + 2 * MIN });
    });

    it("ranks top viewers by diamonds, then messages", () => {
        expect(summary.topViewers[0]).toMatchObject({ uniqueId: "ion", diamonds: 500 });
        expect(summary.topViewers[1]).toMatchObject({ uniqueId: "ana", diamonds: 5, messages: 2 });
    });

    it("handles an empty, still-running session", () => {
        const empty = buildSummary({ id: 1, username: "x", startedAt: START }, [], [], null, START + 30_000);
        expect(empty.durationMs).toBe(30_000);
        expect(empty.timeline).toHaveLength(1);
        expect(empty.moments).toEqual([]);
        expect(empty.stats.likes).toBe(0);
    });
});

describe("CSV export", () => {
    it("quotes separators and neutralises formula injection", () => {
        expect(csvField("plain")).toBe("plain");
        expect(csvField('a "b", c')).toBe('"a ""b"", c"');
        expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(csvField("-5")).toBe("'-5");
        expect(csvField(-5)).toBe("-5");
        expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    });

    it("writes a header plus one row per stat, moment, viewer and minute", () => {
        const summary = buildSummary(
            { id: 1, username: "creator", startedAt: START, endedAt: START + MIN },
            [ev("gift", "ion", 1_000, { diamonds: 10, text: "Rose, x10" })],
            [],
            {},
        );
        const csv = summaryToCsv(summary);
        const lines = csv.trimEnd().split("\r\n");
        expect(lines[0]).toBe("section,time,kind,user,name,detail,value");
        expect(lines[1]).toContain("session,2026-10-05T18:00:00.000Z,start,creator");
        expect(lines.filter((l) => l.startsWith("stat,"))).toHaveLength(9);
        expect(lines).toContain('moment,2026-10-05T18:00:01.000Z,gift,,ION,"Rose, x10",10');
        expect(lines.filter((l) => l.startsWith("viewer,"))).toHaveLength(1);
        expect(lines.filter((l) => l.startsWith("minute,"))).toHaveLength(1);
        expect(csv.endsWith("\r\n")).toBe(true);
    });

    it("JSON export is tagged and round-trips", () => {
        const summary = buildSummary({ id: 2, username: "c", startedAt: START, endedAt: START + MIN }, [], [], {});
        const parsed = JSON.parse(summaryToJson(summary)) as { format: string; session: { id: number } };
        expect(parsed.format).toBe("tiksee-session-summary");
        expect(parsed.session.id).toBe(2);
    });
});
