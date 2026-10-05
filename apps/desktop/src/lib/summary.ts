import type { ExportFormat, SessionInfo } from "@tiksee/core";

/** `tiksee-<handle>-2026-10-05-1830.csv` — safe on Windows, sortable by date. */
export function summaryFileName(session: SessionInfo, format: ExportFormat): string {
    const d = new Date(session.startedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const handle = session.username.replace(/[^\p{L}\p{N}._-]+/gu, "").slice(0, 40) || "live";
    return `tiksee-${handle}-${stamp}.${format}`;
}
