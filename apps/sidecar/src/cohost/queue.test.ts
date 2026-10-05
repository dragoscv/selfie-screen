import { liveControlStateSchema, type ReplyItem } from "@tiksee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TokenBucket } from "./bucket.js";
import { speakBlock } from "./gate.js";
import { ReplyQueue, type EntryKind, type QueueEntry } from "./queue.js";

describe("TokenBucket", () => {
    it("allows a burst of 2 then refills at the configured rate", () => {
        const bucket = new TokenBucket(4, 2, 0);
        expect(bucket.tryTake(0)).toBe(true);
        expect(bucket.tryTake(0)).toBe(true);
        expect(bucket.tryTake(0)).toBe(false);
        expect(bucket.msUntilNext(0)).toBe(15_000);
        expect(bucket.tryTake(14_999)).toBe(false);
        expect(bucket.tryTake(15_000)).toBe(true);
    });

    it("never exceeds the burst, refunds, and honours rate changes", () => {
        const bucket = new TokenBucket(4, 2, 0);
        expect(bucket.available(10 * 60_000)).toBe(2);
        bucket.tryTake(600_000);
        bucket.tryTake(600_000);
        bucket.refund(600_000);
        expect(bucket.available(600_000)).toBe(1);
        bucket.tryTake(600_000);
        bucket.setRate(60, 600_000);
        expect(bucket.tryTake(601_000)).toBe(true);
    });
});

describe("speakBlock", () => {
    const control = liveControlStateSchema.parse({});
    const input = { control, lastTranscriptAt: 0, quietAfterStreamerMs: 1500, voiceEnabled: true, now: 10_000 };

    it("allows speech when nothing blocks", () => {
        expect(speakBlock(input)).toBeNull();
    });

    it("blocks in priority order", () => {
        expect(speakBlock({ ...input, voiceEnabled: false })).toBe("voiceOff");
        expect(speakBlock({ ...input, control: { ...control, shopMode: true, muted: true } })).toBe("shopMode");
        expect(speakBlock({ ...input, control: { ...control, muted: true } })).toBe("muted");
        expect(speakBlock({ ...input, control: { ...control, repliesPaused: true } })).toBe("repliesPaused");
        expect(speakBlock({ ...input, control: { ...control, speakingId: "x" } })).toBe("speaking");
    });

    it("waits out the quiet window after the streamer's last word", () => {
        expect(speakBlock({ ...input, lastTranscriptAt: 9_000 })).toBe("streamerTalking");
        expect(speakBlock({ ...input, lastTranscriptAt: 8_500 })).toBeNull();
    });
});

function entry(id: string, score: number, at: number, kind: EntryKind = "ai", status: ReplyItem["status"] = "pending"): QueueEntry {
    return {
        item: { id, uniqueId: id, nickname: id, message: "m", score, reasons: [], status, at },
        kind,
        approved: kind !== "ai",
        parts: status === "ready" ? ["text"] : [],
        streaming: false,
    };
}

describe("ReplyQueue", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("caps active items, evicting the weakest pending only for a stronger newcomer", () => {
        const queue = new ReplyQueue(2, () => undefined);
        expect(queue.add(entry("a", 5, 0), 0)).toBe(true);
        expect(queue.add(entry("b", 3, 0), 0)).toBe(true);
        expect(queue.add(entry("c", 2, 0), 0)).toBe(false);
        expect(queue.add(entry("d", 9, 0), 0)).toBe(true);
        expect(queue.get("b")?.item.status).toBe("skipped");
        expect(queue.activeCount()).toBe(2);
        queue.dispose();
    });

    it("ranks with recency decay", () => {
        const queue = new ReplyQueue(8, () => undefined);
        queue.add(entry("old", 6, 0), 0);
        queue.add(entry("new", 4, 60_000), 60_000);
        // old decays to 1.5 after 60 s; new is 4.
        expect(queue.topPending(60_000, new Set<EntryKind>(["ai"]))?.item.id).toBe("new");
        queue.dispose();
    });

    it("only offers approved AI drafts for speaking", () => {
        const queue = new ReplyQueue(8, () => undefined);
        queue.add(entry("ai", 9, 0, "ai", "ready"), 0);
        queue.add(entry("thanks", 5, 0, "thanks", "ready"), 0);
        const eligible = (e: QueueEntry) => e.approved || e.kind !== "ai";
        expect(queue.nextSpeakable(0, eligible)?.item.id).toBe("thanks");
        const ai = queue.get("ai");
        if (ai) ai.approved = true;
        expect(queue.nextSpeakable(0, eligible)?.item.id).toBe("ai");
        queue.dispose();
    });

    it("expires unspoken items past their deadline", () => {
        const queue = new ReplyQueue(8, () => undefined);
        const e = entry("x", 3, 0, "read", "ready");
        e.expiresAt = 1000;
        queue.add(e, 0);
        expect(queue.expire(999)).toBe(0);
        expect(queue.expire(1001)).toBe(1);
        expect(queue.get("x")?.item.status).toBe("skipped");
        queue.dispose();
    });

    it("coalesces broadcasts to at most one per 100 ms", () => {
        vi.useFakeTimers();
        const onChange = vi.fn();
        const queue = new ReplyQueue(20, onChange);
        for (let i = 0; i < 10; i += 1) queue.add(entry(`e${i}`, i, i), i);
        expect(onChange).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]?.[0]).toHaveLength(10);
        queue.update("e1", { status: "done" });
        queue.update("e2", { status: "done" });
        vi.advanceTimersByTime(50);
        expect(onChange).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60);
        expect(onChange).toHaveBeenCalledTimes(2);
        queue.dispose();
    });
});
