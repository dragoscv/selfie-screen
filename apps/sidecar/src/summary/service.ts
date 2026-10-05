import { writeFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import type { ExportFormat, SessionInfo, SessionSummary } from "@tiksee/core";

import type { ViewerMemory } from "../memory/db.js";
import { err, ok, type Result } from "../result.js";
import { buildSummary, summaryToCsv, summaryToJson } from "./summary.js";

/** Reads a session out of viewer memory and renders or exports its summary. */
export class SummaryService {
    #memory: ViewerMemory | null;
    #now: () => number;

    constructor(memory: ViewerMemory | null, now: () => number = Date.now) {
        this.#memory = memory;
        this.#now = now;
    }

    sessions(): SessionInfo[] {
        return this.#memory?.sessions() ?? [];
    }

    summary(sessionId?: number): Result<SessionSummary, string> {
        const memory = this.#memory;
        if (!memory) return err("Viewer memory is unavailable");
        const id = sessionId ?? memory.sessions(1)[0]?.id;
        if (id === undefined) return err("No sessions recorded yet");
        const record = memory.session(id);
        if (!record) return err("Session not found");
        const end = record.info.endedAt ?? this.#now();
        return ok(buildSummary(record.info, memory.sessionEvents(id), memory.highlightsBetween(record.info.startedAt, end), record.stats, this.#now()));
    }

    /**
     * Write the summary to `path` (from the native save dialog). The socket is
     * loopback-only but still untrusted input: only absolute paths with the
     * matching extension are accepted.
     */
    async export(sessionId: number, format: ExportFormat, path: string): Promise<Result<string, string>> {
        if (!isAbsolute(path) || extname(path).toLowerCase() !== `.${format}`) return err(`Choose a .${format} file`);
        const summary = this.summary(sessionId);
        if (!summary.ok) return summary;
        const body = format === "csv" ? `\uFEFF${summaryToCsv(summary.value)}` : summaryToJson(summary.value);
        try {
            await writeFile(path, body, "utf8");
            return ok(path);
        } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
        }
    }
}
