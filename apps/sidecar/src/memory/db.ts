import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { eventDiamonds, type ChatEvent, type SessionInfo, type ViewerCard } from "@tiksee/core";

import type { StoredEvent } from "../summary/summary.js";
import { loadSqlite, type Db } from "./sqlite.js";

/**
 * Viewer memory (WS20-09): who came back, what they said about themselves,
 * what each session looked like. One SQLite file per user profile, opened
 * with Node's built-in `node:sqlite` — no native dependency to ship.
 *
 * Schema evolves through `PRAGMA user_version`; each migration runs once in a
 * transaction, in order, and never edits an earlier step.
 */

const MIGRATIONS: readonly string[] = [
    // 1 — core tables
    `CREATE TABLE people (
        unique_id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        avatar_url TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        visits INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        total_diamonds INTEGER NOT NULL DEFAULT 0,
        follower INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        stats_json TEXT
    );
    CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        unique_id TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL,
        diamonds INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX events_session ON events(session_id);
    CREATE INDEX events_at ON events(at);
    CREATE TABLE facts (
        unique_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (unique_id, fact)
    );`,
    // 2 — highlight markers (WS20-11 / Live Control)
    `CREATE TABLE highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        note TEXT NOT NULL
    );
    CREATE INDEX highlights_at ON highlights(at);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
export const MAX_FACTS_PER_VIEWER = 20;
const DAY_MS = 86_400_000;

export interface Person {
    uniqueId: string;
    nickname: string;
    avatarUrl?: string;
    firstSeen: number;
    lastSeen: number;
    visits: number;
    messages: number;
    totalDiamonds: number;
    follower: boolean;
}

export interface Observation {
    /** State before this event; `null` for a viewer never seen before. */
    before: Person | null;
    /** First event from this viewer in this session. */
    firstThisSession: boolean;
}

export interface HighlightRow {
    at: number;
    note: string;
}

export interface SessionRecord {
    info: SessionInfo;
    /** Final stats JSON written by `endSession`, parsed; null while running. */
    stats: unknown;
}

type Row = Record<string, unknown>;

function str(value: unknown): string {
    return typeof value === "string" ? value : String(value ?? "");
}
function num(value: unknown): number {
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function toPerson(row: Row): Person {
    const avatar = row.avatar_url;
    return {
        uniqueId: str(row.unique_id),
        nickname: str(row.nickname),
        ...(typeof avatar === "string" && avatar !== "" ? { avatarUrl: avatar } : {}),
        firstSeen: num(row.first_seen),
        lastSeen: num(row.last_seen),
        visits: num(row.visits),
        messages: num(row.messages),
        totalDiamonds: num(row.total_diamonds),
        follower: num(row.follower) === 1,
    };
}

export class ViewerMemory {
    #db: Db;
    /** `${sessionKey}\u0000${uniqueId}` — a visit counts once per session per viewer. */
    #visited = new Set<string>();
    persistHistory = true;

    private constructor(db: Db) {
        this.#db = db;
        this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
        this.#migrate();
    }

    /** Open (or create) `tiksee.db` in `dir`. Use `:memory:` as dir for an ephemeral db. */
    static open(dir: string): ViewerMemory {
        const { DatabaseSync } = loadSqlite();
        if (dir === ":memory:") return new ViewerMemory(new DatabaseSync(":memory:"));
        mkdirSync(dir, { recursive: true });
        return new ViewerMemory(new DatabaseSync(join(dir, "tiksee.db")));
    }

    get version(): number {
        return num((this.#db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version);
    }

    #migrate(): void {
        for (let version = this.version; version < MIGRATIONS.length; version += 1) {
            const sql = MIGRATIONS[version] ?? "";
            this.#db.exec("BEGIN");
            try {
                this.#db.exec(sql);
                // PRAGMA does not accept bound parameters; `version` is a loop integer.
                this.#db.exec(`PRAGMA user_version = ${version + 1}`);
                this.#db.exec("COMMIT");
            } catch (error) {
                this.#db.exec("ROLLBACK");
                throw error;
            }
        }
    }

    startSession(username: string, at = Date.now()): number {
        const result = this.#db.prepare("INSERT INTO sessions (username, started_at) VALUES (?, ?)").run(username, at);
        return num(result.lastInsertRowid);
    }

    endSession(id: number, stats: unknown, at = Date.now()): void {
        this.#db.prepare("UPDATE sessions SET ended_at = ?, stats_json = ? WHERE id = ?").run(at, JSON.stringify(stats), id);
        for (const key of [...this.#visited]) if (key.startsWith(`${id}\u0000`)) this.#visited.delete(key);
    }

    person(uniqueId: string): Person | null {
        const row = this.#db.prepare("SELECT * FROM people WHERE unique_id = ?").get(uniqueId) as Row | undefined;
        return row ? toPerson(row) : null;
    }

    /**
     * Record one live event. Replay events and events outside a live session
     * (simulated/demo) touch nothing on disk — they only update the in-memory
     * "seen this session" set so scoring stays consistent.
     */
    observe(event: ChatEvent, sessionId: number | null): Observation {
        const uniqueId = event.user.uniqueId;
        if (uniqueId === "") return { before: null, firstThisSession: false };
        const visitKey = `${sessionId ?? "adhoc"}\u0000${uniqueId}`;
        const firstThisSession = !this.#visited.has(visitKey);
        if (firstThisSession) this.#visited.add(visitKey);

        const before = this.person(uniqueId);
        if (event.replay || sessionId === null) return { before, firstThisSession };

        const diamonds = eventDiamonds(event);
        const message = event.kind === "chat" ? 1 : 0;
        const visit = firstThisSession ? 1 : 0;
        const follower = event.kind === "follow" || event.user.isFollower === true ? 1 : 0;
        this.#db
            .prepare(
                `INSERT INTO people (unique_id, nickname, avatar_url, first_seen, last_seen, visits, messages, total_diamonds, follower)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(unique_id) DO UPDATE SET
                    nickname = excluded.nickname,
                    avatar_url = COALESCE(excluded.avatar_url, people.avatar_url),
                    last_seen = excluded.last_seen,
                    visits = people.visits + excluded.visits,
                    messages = people.messages + excluded.messages,
                    total_diamonds = people.total_diamonds + excluded.total_diamonds,
                    follower = MAX(people.follower, excluded.follower)`,
            )
            .run(uniqueId, event.user.nickname, event.user.avatarUrl ?? null, event.at, event.at, visit, message, diamonds, follower);

        if (this.persistHistory && event.kind !== "like") {
            this.#db
                .prepare("INSERT INTO events (session_id, kind, unique_id, text, at, diamonds) VALUES (?, ?, ?, ?, ?, ?)")
                .run(sessionId, event.kind, uniqueId, event.text.slice(0, 500), event.at, diamonds);
        }
        return { before, firstThisSession };
    }

    facts(uniqueId: string): string[] {
        const rows = this.#db.prepare("SELECT fact FROM facts WHERE unique_id = ? ORDER BY at DESC").all(uniqueId) as Row[];
        return rows.map((row) => str(row.fact));
    }

    /** Store durable facts, newest wins; keeps at most 20 per viewer. */
    addFacts(uniqueId: string, facts: readonly string[], at = Date.now()): void {
        const insert = this.#db.prepare(
            "INSERT INTO facts (unique_id, fact, at) VALUES (?, ?, ?) ON CONFLICT(unique_id, fact) DO UPDATE SET at = excluded.at",
        );
        let offset = 0;
        for (const fact of facts) {
            const clean = fact.trim().slice(0, 200);
            if (clean !== "") insert.run(uniqueId, clean, at + offset++);
        }
        this.#db
            .prepare(
                `DELETE FROM facts WHERE unique_id = ? AND fact NOT IN (
                    SELECT fact FROM facts WHERE unique_id = ? ORDER BY at DESC LIMIT ?)`,
            )
            .run(uniqueId, uniqueId, MAX_FACTS_PER_VIEWER);
    }

    card(uniqueId: string, greeting?: string): ViewerCard | null {
        const person = this.person(uniqueId);
        if (!person) return null;
        return {
            uniqueId: person.uniqueId,
            nickname: person.nickname,
            ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
            visits: person.visits,
            firstSeen: person.firstSeen,
            lastSeen: person.lastSeen,
            messages: person.messages,
            totalDiamonds: person.totalDiamonds,
            facts: this.facts(uniqueId).slice(0, 5),
            ...(greeting ? { greeting } : {}),
        };
    }

    addHighlight(note: string, at = Date.now()): void {
        this.#db.prepare("INSERT INTO highlights (at, note) VALUES (?, ?)").run(at, note.slice(0, 2000));
    }

    highlights(since = 0): HighlightRow[] {
        const rows = this.#db.prepare("SELECT at, note FROM highlights WHERE at >= ? ORDER BY at").all(since) as Row[];
        return rows.map((row) => ({ at: num(row.at), note: str(row.note) }));
    }

    highlightsBetween(from: number, to: number): HighlightRow[] {
        const rows = this.#db.prepare("SELECT at, note FROM highlights WHERE at >= ? AND at <= ? ORDER BY at").all(from, to) as Row[];
        return rows.map((row) => ({ at: num(row.at), note: str(row.note) }));
    }

    /** Most recent sessions first (post-live summary picker). */
    sessions(limit = 30): SessionInfo[] {
        const rows = this.#db
            .prepare("SELECT id, username, started_at, ended_at FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?")
            .all(limit) as Row[];
        return rows.map(toSessionInfo);
    }

    session(id: number): SessionRecord | null {
        const row = this.#db.prepare("SELECT id, username, started_at, ended_at, stats_json FROM sessions WHERE id = ?").get(id) as Row | undefined;
        if (!row) return null;
        let stats: unknown = null;
        if (typeof row.stats_json === "string") {
            try {
                stats = JSON.parse(row.stats_json);
            } catch {
                stats = null;
            }
        }
        return { info: toSessionInfo(row), stats };
    }

    /** Every stored event of a session, oldest first, with the viewer's current nickname. */
    sessionEvents(id: number): StoredEvent[] {
        const rows = this.#db
            .prepare(
                `SELECT e.kind, e.unique_id, COALESCE(p.nickname, e.unique_id) AS nickname, e.text, e.at, e.diamonds
                 FROM events e LEFT JOIN people p ON p.unique_id = e.unique_id
                 WHERE e.session_id = ? ORDER BY e.at, e.id`,
            )
            .all(id) as Row[];
        return rows.map((row) => ({
            kind: str(row.kind),
            uniqueId: str(row.unique_id),
            nickname: str(row.nickname),
            text: str(row.text),
            at: num(row.at),
            diamonds: num(row.diamonds),
        }));
    }

    /** Delete sessions, events and highlights older than `days` (0 keeps forever). */
    prune(days: number, now = Date.now()): number {
        if (days <= 0) return 0;
        const cutoff = now - days * DAY_MS;
        const events = this.#db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
        this.#db.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoff);
        this.#db.prepare("DELETE FROM highlights WHERE at < ?").run(cutoff);
        return num(events.changes);
    }

    count(table: "people" | "sessions" | "events" | "facts" | "highlights"): number {
        return num((this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined)?.n);
    }

    close(): void {
        if (this.#db.isOpen) this.#db.close();
    }
}

function toSessionInfo(row: Row): SessionInfo {
    const ended = row.ended_at;
    return {
        id: num(row.id),
        username: str(row.username),
        startedAt: num(row.started_at),
        ...(ended !== null && ended !== undefined ? { endedAt: num(ended) } : {}),
    };
}
