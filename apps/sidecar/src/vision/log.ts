import type { SignalEvent, SignalId, Subject, VisionLogEntry, VisionLogStat } from "@tiksee/core";

import type { Db } from "../memory/sqlite.js";

/**
 * Vision log (0.3.0): one row per finished state interval (`end`, with its
 * duration) or momentary signal (`pulse`, duration 0). `start` edges stay in
 * memory until their `end`; `close()` flushes still-open intervals with the
 * duration so far. Writes are batched into one transaction per second.
 */

const DAY_MS = 86_400_000;
export const FLUSH_MS = 1000;

interface Pending {
    signal: SignalId;
    subject: Subject;
    startedAt: number;
    durationMs: number;
    confidence: number;
    sessionId: number | undefined;
}

interface OpenInterval {
    signal: SignalId;
    subject: Subject;
    startedAt: number;
    confidence: number;
}

export interface VisionLogDeps {
    db: Db;
    /** Current live session, when the hub has one. */
    sessionId?: () => number | undefined;
    now?: () => number;
}

export interface VisionLogQuery {
    sinceMs?: number;
    signal?: SignalId;
    limit?: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0));

function key(signal: SignalId, subject: Subject): string {
    return `${signal}#${subject.kind}#${subject.track}`;
}

export class VisionLog {
    #db: Db;
    #sessionId: () => number | undefined;
    #now: () => number;
    #open = new Map<string, OpenInterval>();
    #pending: Pending[] = [];
    #flushTimer: ReturnType<typeof setTimeout> | null = null;
    #retentionTimer: ReturnType<typeof setInterval> | null = null;
    #retentionDays = 30;
    enabled = true;

    constructor(deps: VisionLogDeps) {
        this.#db = deps.db;
        this.#sessionId = deps.sessionId ?? (() => undefined);
        this.#now = deps.now ?? (() => Date.now());
    }

    /** Apply retention now and once a day. */
    setRetention(days: number): void {
        this.#retentionDays = days;
        this.prune();
        if (!this.#retentionTimer) {
            this.#retentionTimer = setInterval(() => this.prune(), DAY_MS);
            this.#retentionTimer.unref?.();
        }
    }

    record(events: readonly SignalEvent[]): void {
        if (!this.enabled) return;
        for (const event of events) {
            const k = key(event.signal, event.subject);
            if (event.phase === "start") {
                if (!this.#open.has(k)) {
                    this.#open.set(k, { signal: event.signal, subject: event.subject, startedAt: event.at, confidence: event.confidence });
                }
            } else if (event.phase === "end") {
                const open = this.#open.get(k);
                this.#open.delete(k);
                const durationMs = event.durationMs ?? (open ? Math.max(0, event.at - open.startedAt) : 0);
                const startedAt = open?.startedAt ?? event.at - durationMs;
                this.#queue({
                    signal: event.signal,
                    subject: event.subject,
                    startedAt,
                    durationMs,
                    confidence: Math.max(open?.confidence ?? 0, event.confidence),
                    sessionId: this.#sessionId(),
                });
            } else {
                this.#queue({
                    signal: event.signal,
                    subject: event.subject,
                    startedAt: event.at,
                    durationMs: 0,
                    confidence: event.confidence,
                    sessionId: this.#sessionId(),
                });
            }
        }
    }

    #queue(row: Pending): void {
        this.#pending.push(row);
        if (!this.#flushTimer) {
            this.#flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
            this.#flushTimer.unref?.();
        }
    }

    /** Write every pending row in one transaction. */
    flush(): number {
        if (this.#flushTimer) clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
        const rows = this.#pending;
        this.#pending = [];
        if (rows.length === 0 || !this.#db.isOpen) return 0;
        const insert = this.#db.prepare(
            `INSERT INTO vision_events (signal, subject_kind, subject_name, owner, started_at, duration_ms, confidence, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.#db.exec("BEGIN");
        try {
            for (const r of rows) {
                insert.run(r.signal, r.subject.kind, r.subject.name ?? null, r.subject.owner ? 1 : 0, r.startedAt, Math.round(r.durationMs), r.confidence, r.sessionId ?? null);
            }
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
        return rows.length;
    }

    query(q: VisionLogQuery = {}): { entries: VisionLogEntry[]; stats: VisionLogStat[] } {
        this.flush();
        const since = q.sinceMs ?? 0;
        const limit = q.limit ?? 500;
        const where = q.signal ? "started_at >= ? AND signal = ?" : "started_at >= ?";
        const params: (number | string)[] = q.signal ? [since, q.signal] : [since];
        const rows = this.#db
            .prepare(`SELECT * FROM vision_events WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
            .all(...params, limit) as Row[];
        const entries: VisionLogEntry[] = rows.map((row) => ({
            id: num(row.id),
            signal: row.signal as SignalId,
            ...(typeof row.subject_name === "string" ? { subjectName: row.subject_name } : {}),
            subjectKind: row.subject_kind === "dog" ? "dog" : "person",
            owner: num(row.owner) === 1,
            startedAt: num(row.started_at),
            durationMs: num(row.duration_ms),
            confidence: num(row.confidence),
            ...(row.session_id !== null && row.session_id !== undefined ? { sessionId: num(row.session_id) } : {}),
        }));
        const statRows = this.#db
            .prepare(
                `SELECT signal, COUNT(*) AS n, SUM(duration_ms) AS total, MAX(duration_ms) AS longest
                 FROM vision_events WHERE ${where} GROUP BY signal ORDER BY total DESC, n DESC`,
            )
            .all(...params) as Row[];
        const stats: VisionLogStat[] = statRows.map((row) => ({
            signal: row.signal as SignalId,
            count: num(row.n),
            totalMs: num(row.total),
            longestMs: num(row.longest),
        }));
        return { entries, stats };
    }

    clear(): number {
        this.#pending = [];
        return num(this.#db.prepare("DELETE FROM vision_events").run().changes);
    }

    prune(now = this.#now()): number {
        if (!this.#db.isOpen) return 0;
        const cutoff = now - this.#retentionDays * DAY_MS;
        return num(this.#db.prepare("DELETE FROM vision_events WHERE started_at < ?").run(cutoff).changes);
    }

    /** Close every open interval with its duration so far, then write. */
    close(): void {
        const now = this.#now();
        const sessionId = this.#sessionId();
        for (const open of this.#open.values()) {
            this.#pending.push({ ...open, durationMs: Math.max(0, now - open.startedAt), sessionId });
        }
        this.#open.clear();
        if (this.#retentionTimer) clearInterval(this.#retentionTimer);
        this.#retentionTimer = null;
        this.flush();
    }
}
