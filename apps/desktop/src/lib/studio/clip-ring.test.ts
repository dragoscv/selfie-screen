import { describe, expect, it } from "vitest";

import { ClipRing, clipByteBudget, clipFileName, type ClipChunk } from "./clip-ring.js";
import { clipCodec } from "./clips.js";

const FRAME = 33_333;
/** 30 fps, keyframe every 30 frames, `size` bytes each. */
function feed(ring: ClipRing, frames: number, size = 100, start = 0): void {
    for (let i = start; i < start + frames; i++) {
        const c: ClipChunk = { data: new Uint8Array(size), key: i % 30 === 0, ts: i * FRAME, dur: FRAME };
        ring.push(c);
    }
}

describe("ClipRing", () => {
    it("refuses delta frames until the first keyframe", () => {
        const ring = new ClipRing(30e6, 1e9);
        expect(ring.push({ data: new Uint8Array(1), key: false, ts: 0, dur: FRAME })).toBe(false);
        expect(ring.length).toBe(0);
        expect(ring.push({ data: new Uint8Array(1), key: true, ts: 0, dur: FRAME })).toBe(true);
    });

    it("keeps between the window and window + one GOP, always starting on a keyframe", () => {
        const ring = new ClipRing(30e6, 1e9);
        feed(ring, 30 * 120);
        const snap = ring.snapshot();
        expect(snap[0]?.key).toBe(true);
        expect(ring.durationUs).toBeGreaterThanOrEqual(30e6 - FRAME);
        expect(ring.durationUs).toBeLessThanOrEqual(31e6 + FRAME);
        expect(ring.bytes).toBe(snap.length * 100);
    });

    it("bounds memory by dropping whole GOPs when over the byte cap", () => {
        // 30 s at 100 B/frame = 90 KB; cap at 30 KB keeps ~10 s.
        const ring = new ClipRing(30e6, 30_000);
        feed(ring, 30 * 60);
        expect(ring.bytes).toBeLessThanOrEqual(30_000);
        expect(ring.snapshot()[0]?.key).toBe(true);
        expect(ring.durationUs).toBeGreaterThan(8e6);
    });

    it("never drops the newest GOP even when one GOP exceeds the cap", () => {
        const ring = new ClipRing(30e6, 10);
        feed(ring, 45, 100);
        expect(ring.snapshot()[0]?.ts).toBe(30 * FRAME);
        expect(ring.length).toBe(15);
    });

    it("shrinking the window takes effect on the next push", () => {
        const ring = new ClipRing(30e6, 1e9);
        feed(ring, 30 * 40);
        ring.windowUs = 5e6;
        feed(ring, 1, 100, 30 * 40);
        expect(ring.durationUs).toBeLessThanOrEqual(6e6 + FRAME);
        ring.clear();
        expect(ring.bytes).toBe(0);
        expect(ring.durationUs).toBe(0);
    });
});

describe("clip helpers", () => {
    it("names clips by local time, sortable and filesystem-safe", () => {
        expect(clipFileName(new Date(2026, 9, 6, 4, 5, 9))).toBe("TikSee-20261006-040509.mp4");
    });

    it("budgets RAM from bitrate and window with headroom", () => {
        // 8 Mbps x 32 s x 1.5 = 48 MB.
        expect(clipByteBudget(8, 30)).toBe(48_000_000);
    });

    it("picks an H.264 level that fits the frame size", () => {
        expect(clipCodec(1080, 1920)).toBe("avc1.640028");
        expect(clipCodec(1920, 1080)).toBe("avc1.640028");
        expect(clipCodec(2160, 3840)).toBe("avc1.640033");
    });
});
