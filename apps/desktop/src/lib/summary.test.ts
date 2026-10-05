import { describe, expect, it } from "vitest";

import { summaryFileName } from "./summary.js";

describe("summaryFileName", () => {
    it("builds a Windows-safe, date-stamped name", () => {
        const at = new Date(2026, 9, 5, 18, 7).getTime();
        expect(summaryFileName({ id: 1, username: "ana.maria_99", startedAt: at }, "csv")).toBe("tiksee-ana.maria_99-2026-10-05-1807.csv");
        expect(summaryFileName({ id: 1, username: 'a<b>:"c', startedAt: at }, "json")).toBe("tiksee-abc-2026-10-05-1807.json");
        expect(summaryFileName({ id: 1, username: "", startedAt: at }, "json")).toBe("tiksee-live-2026-10-05-1807.json");
    });
});
