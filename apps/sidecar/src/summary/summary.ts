import type { SessionInfo, SessionSummary, SummaryMoment, SummaryViewer } from "@tiksee/core";

/**
 * Post-live summary (WS20-10): pure functions that turn stored session rows
 * into top moments, top viewers and stats, plus CSV/JSON export. The SQLite
 * reads live in `memory/db.ts`; nothing here touches I/O.
 */

export interface StoredEvent {
    kind: string;
    uniqueId: string;
    nickname: string;
    text: string;
    at: number;
    diamonds: number;
}

export interface StoredHighlight {
    at: number;
    note: string;
}

const MINUTE_MS = 60_000;
const TOP_GIFTS = 5;
const TOP_SPIKES = 3;
const TOP_VIEWERS = 10;
const MAX_HIGHLIGHTS = 20;
/** A spike needs at least this many messages in its minute. */
const SPIKE_MIN_MESSAGES = 8;

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Minutes whose chat rate is at least twice the session median (and above a
 * floor), strongest first. Returns `{ minute, messages }`.
 */
export function findSpikes(perMinute: readonly number[], limit = TOP_SPIKES): Array<{ minute: number; messages: number }> {
    const base = median(perMinute.filter((n) => n > 0));
    const threshold = Math.max(SPIKE_MIN_MESSAGES, base * 2);
    return perMinute
        .map((messages, minute) => ({ minute, messages }))
        .filter((m) => m.messages >= threshold)
        .sort((a, b) => b.messages - a.messages || a.minute - b.minute)
        .slice(0, limit);
}

export function buildSummary(
    session: SessionInfo,
    events: readonly StoredEvent[],
    highlights: readonly StoredHighlight[],
    rawStats: unknown,
    now = Date.now(),
): SessionSummary {
    const end = session.endedAt ?? Math.max(now, events.at(-1)?.at ?? session.startedAt);
    const durationMs = Math.max(0, end - session.startedAt);
    const minutes = Math.max(1, Math.ceil(durationMs / MINUTE_MS));
    const timeline = Array.from({ length: minutes }, (_, minute) => ({ minute, messages: 0, diamonds: 0 }));

    const counts = { messages: 0, gifts: 0, diamonds: 0, follows: 0, shares: 0, joins: 0 };
    const viewers = new Map<string, SummaryViewer>();
    const giftEvents: StoredEvent[] = [];

    for (const event of events) {
        const minute = Math.min(minutes - 1, Math.max(0, Math.floor((event.at - session.startedAt) / MINUTE_MS)));
        const bucket = timeline[minute];
        const viewer =
            event.uniqueId === ""
                ? null
                : (viewers.get(event.uniqueId) ??
                  viewers
                      .set(event.uniqueId, { uniqueId: event.uniqueId, nickname: event.nickname || event.uniqueId, messages: 0, gifts: 0, diamonds: 0 })
                      .get(event.uniqueId) ??
                  null);
        switch (event.kind) {
            case "chat":
                counts.messages += 1;
                if (bucket) bucket.messages += 1;
                if (viewer) viewer.messages += 1;
                break;
            case "gift":
                counts.gifts += 1;
                counts.diamonds += event.diamonds;
                if (bucket) bucket.diamonds += event.diamonds;
                if (viewer) {
                    viewer.gifts += 1;
                    viewer.diamonds += event.diamonds;
                }
                giftEvents.push(event);
                break;
            case "follow":
                counts.follows += 1;
                break;
            case "share":
                counts.shares += 1;
                break;
            case "join":
                counts.joins += 1;
                break;
        }
    }

    const moments: SummaryMoment[] = [];
    for (const gift of [...giftEvents].sort((a, b) => b.diamonds - a.diamonds || a.at - b.at).slice(0, TOP_GIFTS)) {
        if (gift.diamonds <= 0) continue;
        moments.push({ at: gift.at, kind: "gift", title: gift.nickname || gift.uniqueId, detail: gift.text, value: gift.diamonds });
    }
    for (const highlight of highlights.slice(0, MAX_HIGHLIGHTS)) {
        moments.push({ at: highlight.at, kind: "highlight", title: highlight.note.slice(0, 120), detail: highlight.note, value: 0 });
    }
    for (const spike of findSpikes(timeline.map((t) => t.messages))) {
        moments.push({
            at: session.startedAt + spike.minute * MINUTE_MS,
            kind: "spike",
            title: `${spike.messages}`,
            detail: `minute ${spike.minute + 1}`,
            value: spike.messages,
        });
    }
    moments.sort((a, b) => a.at - b.at);

    const topViewers = [...viewers.values()]
        .filter((v) => v.messages > 0 || v.diamonds > 0)
        .sort((a, b) => b.diamonds - a.diamonds || b.messages - a.messages || a.nickname.localeCompare(b.nickname))
        .slice(0, TOP_VIEWERS);

    const stored = rawStats && typeof rawStats === "object" ? (rawStats as Record<string, unknown>) : {};
    return {
        session,
        durationMs,
        stats: {
            messages: Math.max(counts.messages, num(stored.messages)),
            gifts: Math.max(counts.gifts, num(stored.gifts)),
            diamonds: Math.max(counts.diamonds, num(stored.diamonds)),
            follows: Math.max(counts.follows, num(stored.follows)),
            shares: Math.max(counts.shares, num(stored.shares)),
            joins: Math.max(counts.joins, num(stored.joins)),
            // Likes are never stored per event (too frequent); only the final tally knows them.
            likes: num(stored.likes),
            uniqueViewers: Math.max(viewers.size, num(stored.uniqueViewers)),
            peakViewers: num(stored.peakViewers),
        },
        moments,
        topViewers,
        timeline,
    };
}

/* ------------------------------ export ------------------------------ */

/** RFC 4180 field; also neutralises spreadsheet formula injection (=, +, -, @). */
export function csvField(value: string | number): string {
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = ["section", "time", "kind", "user", "name", "detail", "value"] as const;

/** One flat table: stats, moments, then top viewers. CRLF line endings for Excel. */
export function summaryToCsv(summary: SessionSummary): string {
    const iso = (at: number) => new Date(at).toISOString();
    const rows: Array<Array<string | number>> = [[...CSV_HEADER]];
    const { session } = summary;
    rows.push(["session", iso(session.startedAt), "start", session.username, "", session.endedAt ? iso(session.endedAt) : "", summary.durationMs]);
    for (const [key, value] of Object.entries(summary.stats)) rows.push(["stat", "", key, "", "", "", value]);
    for (const m of summary.moments) rows.push(["moment", iso(m.at), m.kind, "", m.title, m.detail, m.value]);
    for (const v of summary.topViewers) rows.push(["viewer", "", "top", v.uniqueId, v.nickname, `${v.gifts} gifts / ${v.messages} messages`, v.diamonds]);
    for (const t of summary.timeline) rows.push(["minute", iso(session.startedAt + t.minute * MINUTE_MS), "activity", "", "", `${t.messages} messages`, t.diamonds]);
    return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export function summaryToJson(summary: SessionSummary): string {
    return `${JSON.stringify({ format: "tiksee-session-summary", version: 1, ...summary }, null, 2)}\n`;
}
