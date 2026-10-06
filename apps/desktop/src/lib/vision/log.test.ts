import type { VisionLogEntry } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { formatMs, logToCsv, statsFrom, windowStart } from "./log.js";

const entry = (over: Partial<VisionLogEntry>): VisionLogEntry => ({
    id: 1,
    signal: "smile",
    subjectKind: "person",
    owner: true,
    startedAt: Date.UTC(2026, 9, 5, 12),
    durationMs: 1200,
    confidence: 0.9,
    ...over,
});

describe("vision log helpers", () => {
    it("formats short and long durations", () => {
        expect(formatMs(400)).toBe("0.4s");
        expect(formatMs(12_000)).toBe("12s");
        expect(formatMs(185_000)).toBe("3m 05s");
        expect(formatMs(3_720_000)).toBe("1h 02m");
    });

    it("computes windows", () => {
        const now = Date.UTC(2026, 9, 5, 12);
        expect(windowStart("15m", now)).toBe(now - 900_000);
        expect(windowStart("today", now)).toBeLessThanOrEqual(now);
    });

    it("aggregates stats by signal", () => {
        const stats = statsFrom([entry({}), entry({ id: 2, durationMs: 3000 }), entry({ id: 3, signal: "nod", durationMs: 0 })]);
        expect(stats[0]).toEqual({ signal: "smile", count: 2, totalMs: 4200, longestMs: 3000 });
        expect(stats[1]?.signal).toBe("nod");
    });

    it("escapes CSV cells", () => {
        const csv = logToCsv([entry({ subjectName: 'Kiri, "the big one"' })]);
        expect(csv.split("\r\n")[1]).toContain('"Kiri, ""the big one"""');
    });
});
