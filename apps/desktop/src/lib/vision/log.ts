import type { VisionLogEntry, VisionLogStat } from "@tiksee/core";

export const LOG_WINDOWS = ["15m", "1h", "today", "7d"] as const;
export type LogWindow = (typeof LOG_WINDOWS)[number];

/** Epoch ms the window starts at, relative to `now`. */
export function windowStart(window: LogWindow, now: number): number {
    switch (window) {
        case "15m":
            return now - 15 * 60_000;
        case "1h":
            return now - 60 * 60_000;
        case "today": {
            const d = new Date(now);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        }
        case "7d":
            return now - 7 * 24 * 60 * 60_000;
    }
}

/** `0.4s`, `12s`, `3m 05s`, `1h 02m` — tenths below 10 s since gestures are short. */
export function formatMs(ms: number): string {
    if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
}

/** Stats recomputed client-side when a person filter narrows the entries. */
export function statsFrom(entries: readonly VisionLogEntry[]): VisionLogStat[] {
    const map = new Map<VisionLogStat["signal"], VisionLogStat>();
    for (const e of entries) {
        const s = map.get(e.signal) ?? { signal: e.signal, count: 0, totalMs: 0, longestMs: 0 };
        s.count++;
        s.totalMs += e.durationMs;
        s.longestMs = Math.max(s.longestMs, e.durationMs);
        map.set(e.signal, s);
    }
    return [...map.values()].sort((a, b) => b.totalMs - a.totalMs || b.count - a.count);
}

const cell = (v: string | number | boolean | undefined): string => {
    const s = v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function logToCsv(entries: readonly VisionLogEntry[]): string {
    const head = ["startedAt", "signal", "subjectKind", "subjectName", "owner", "durationMs", "confidence"];
    const rows = entries.map((e) =>
        [new Date(e.startedAt).toISOString(), e.signal, e.subjectKind, e.subjectName, e.owner, e.durationMs, e.confidence.toFixed(2)]
            .map(cell)
            .join(","),
    );
    return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

/** Who a log entry is about, for the person filter. */
export const subjectLabel = (e: VisionLogEntry): string => e.subjectName ?? (e.owner ? "owner" : e.subjectKind);
