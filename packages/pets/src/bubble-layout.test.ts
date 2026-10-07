import { describe, expect, it } from "vitest";

import {
    BUBBLE_MAX_CHARS,
    bubbleDurationMs,
    emotionGlyph,
    exitFactor,
    layoutBubble,
    popScale,
    revealCount,
    sanitizeBubbleText,
    tailOffsetPx,
    textVisemes,
} from "./bubble-layout.js";

describe("speech bubble layout", () => {
    it("bends the tail toward the pet when the bubble is slid in, never past the rect", () => {
        expect(tailOffsetPx(0, 300)).toBe(0);
        expect(tailOffsetPx(0.1, 300)).toBeCloseTo(51.2);
        expect(tailOffsetPx(-0.1, 300)).toBeCloseTo(-51.2);
        expect(tailOffsetPx(0.9, 300)).toBe(150 - 41);
        expect(tailOffsetPx(-0.9, 300)).toBe(-(150 - 41));
        expect(tailOffsetPx(0.5, 60)).toBe(0);
        expect(tailOffsetPx(Number.NaN, 300)).toBe(0);
    });

    it("wraps on words into at most two lines of 22 chars", () => {
        expect(layoutBubble("Salut!")).toEqual(["Salut!"]);
        const lines = layoutBubble("Bună seara tuturor, mulțumesc pentru cadou");
        expect(lines).toEqual(["Bună seara tuturor,", "mulțumesc pentru cadou"]);
        for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(22);
    });

    it("ends an overflowing second line with an ellipsis", () => {
        const lines = layoutBubble("unu doi trei patru cinci șase șapte opt nouă zece unsprezece doisprezece");
        expect(lines).toHaveLength(2);
        expect(lines[1]?.endsWith("…")).toBe(true);
        expect(Array.from(lines[1] ?? "").length).toBeLessThanOrEqual(22);
    });

    it("splits words longer than a line", () => {
        const lines = layoutBubble("a".repeat(30));
        expect(lines).toEqual(["a".repeat(22), "a".repeat(8)]);
    });

    it("keeps Romanian diacritics as single code points (NFC) and strips control chars", () => {
        const decomposed = "s\u0326i t\u0326"; // ș ț written with combining commas
        expect(sanitizeBubbleText(`${decomposed}\u0007\n ok`)).toBe("și ț ok");
        expect(sanitizeBubbleText("x".repeat(500))).toHaveLength(BUBBLE_MAX_CHARS);
        expect(sanitizeBubbleText("😀".repeat(200))).toBe("😀".repeat(BUBBLE_MAX_CHARS));
        expect(layoutBubble("  \u0000 ")).toEqual([]);
    });

    it("duration: 1.5 s + 60 ms/char within [2.5, 7] s; explicit ttl within [1.5, 9] s", () => {
        expect(bubbleDurationMs("hi")).toBe(2500);
        expect(bubbleDurationMs("x".repeat(40))).toBe(1500 + 2400);
        expect(bubbleDurationMs("x".repeat(120))).toBe(7000);
        expect(bubbleDurationMs("hi", 500)).toBe(1500);
        expect(bubbleDurationMs("hi", 8000)).toBe(8000);
        expect(bubbleDurationMs("hi", 20_000)).toBe(9000);
    });

    it("typewriter reveals 35 chars/s", () => {
        expect(revealCount(50, 0)).toBe(0);
        expect(revealCount(50, 100)).toBe(3);
        expect(revealCount(50, 1000)).toBe(35);
        expect(revealCount(50, 5000)).toBe(50);
    });

    it("pop-in overshoots ~8 % and settles at 1; exit goes to 0 in 200 ms", () => {
        let peak = 0;
        for (let t = 0; t < 1; t += 0.002) peak = Math.max(peak, popScale(t));
        expect(peak).toBeGreaterThan(1.05);
        expect(peak).toBeLessThan(1.11);
        expect(popScale(0)).toBe(0);
        expect(popScale(1.5)).toBeCloseTo(1, 3);
        expect(exitFactor(0)).toBe(1);
        expect(exitFactor(200)).toBe(0);
    });

    it("emotion glyphs (neutral and unknown = none)", () => {
        expect(emotionGlyph("happy")).toBe("😊");
        expect(emotionGlyph("sleepy")).toBe("💤");
        expect(emotionGlyph("neutral")).toBeNull();
        expect(emotionGlyph("angry")).toBeNull();
        expect(emotionGlyph(undefined)).toBeNull();
    });

    it("text visemes open on vowels, close on b/m/p and end at rest", () => {
        const v = textVisemes("mama");
        expect(v.map((e) => e.id)).toEqual([21, 2, 21, 2, 0]);
        expect(v.at(-1)?.offsetMs).toBe(Math.round((4 * 1000) / 35));
    });
});
