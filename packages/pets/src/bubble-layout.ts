import type { VisemeEvent } from "./visemes.js";

/**
 * Pure parts of the pet speech bubble (bubble.ts draws it): text sanitising,
 * word wrap, timing, the pop-in spring and a cheap mouth flap from text.
 * No DOM, no three.js, so it is unit-tested in node.
 */

export const BUBBLE_MAX_CHARS = 120;
export const BUBBLE_LINE_CHARS = 22;
export const BUBBLE_MAX_LINES = 2;
/** Typewriter speed (characters per second). */
export const REVEAL_CPS = 35;
export const BUBBLE_MIN_MS = 2500;
export const BUBBLE_MAX_MS = 7000;
export const TTL_MIN_MS = 1500;
export const TTL_MAX_MS = 9000;
export const MORPH_MS = 180;
export const EXIT_MS = 200;

export const BUBBLE_EMOTIONS = ["neutral", "happy", "excited", "curious", "sleepy", "shy", "proud", "sad"] as const;
export type BubbleEmotion = (typeof BUBBLE_EMOTIONS)[number];

/** Corner glyph per emotion (neutral = none). */
export const EMOTION_GLYPH: Readonly<Record<BubbleEmotion, string | null>> = {
    neutral: null,
    happy: "😊",
    excited: "✨",
    curious: "❓",
    sleepy: "💤",
    shy: "🙈",
    proud: "🌟",
    sad: "💧",
};

export function emotionGlyph(emotion: string | undefined): string | null {
    return emotion && emotion in EMOTION_GLYPH ? EMOTION_GLYPH[emotion as BubbleEmotion] : null;
}

const chars = (s: string): string[] => Array.from(s);

/**
 * Strip control characters, collapse whitespace, NFC (Romanian ș/ț stay one
 * code point), cap at 120 code points without splitting a surrogate pair.
 */
export function sanitizeBubbleText(text: string): string {
    const clean = String(text ?? "")
        .normalize("NFC")
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    const cps = chars(clean);
    return cps.length > BUBBLE_MAX_CHARS ? cps.slice(0, BUBBLE_MAX_CHARS).join("").trimEnd() : clean;
}

/**
 * Greedy word wrap into at most `maxLines` lines of `maxChars` code points.
 * Over-long words are split; overflow ends the last line with an ellipsis.
 */
export function layoutBubble(text: string, maxChars = BUBBLE_LINE_CHARS, maxLines = BUBBLE_MAX_LINES): string[] {
    const words = sanitizeBubbleText(text).split(" ").filter(Boolean);
    const pieces: string[] = [];
    for (const w of words) {
        const cp = chars(w);
        for (let i = 0; i < cp.length; i += maxChars) pieces.push(cp.slice(i, i + maxChars).join(""));
    }
    const lines: string[] = [];
    let cur = "";
    let overflow = false;
    for (const p of pieces) {
        const next = cur ? `${cur} ${p}` : p;
        if (chars(next).length <= maxChars) {
            cur = next;
            continue;
        }
        lines.push(cur);
        cur = p;
        if (lines.length === maxLines) {
            overflow = true;
            break;
        }
    }
    if (!overflow && cur) lines.push(cur);
    if (overflow) {
        const last = chars(lines[maxLines - 1] ?? "");
        const cut = last.length >= maxChars ? last.slice(0, maxChars - 1) : last;
        lines[maxLines - 1] = `${cut.join("").trimEnd()}…`;
    }
    return lines.slice(0, maxLines);
}

/** On-screen time: 1.5 s + 60 ms per char in [2.5, 7] s; an explicit ttl wins, clamped to [1.5, 9] s. */
export function bubbleDurationMs(text: string, ttlMs?: number): number {
    if (ttlMs !== undefined && Number.isFinite(ttlMs)) return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, ttlMs));
    const n = chars(sanitizeBubbleText(text)).length;
    return Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, 1500 + 60 * n));
}

/** Characters revealed `elapsedMs` after the typewriter started. */
export function revealCount(total: number, elapsedMs: number, cps = REVEAL_CPS): number {
    if (!(elapsedMs > 0)) return 0;
    return Math.min(total, Math.floor((elapsedMs * cps) / 1000));
}

/** Total time the typewriter needs for `total` characters. */
export function revealDurationMs(total: number, cps = REVEAL_CPS): number {
    return Math.ceil((total * 1000) / cps);
}

/** Pop-in spring: stiffness 300, damping 22, mass 1 (zeta ~0.64, overshoot ~8 %). */
export const POP_STIFFNESS = 300;
export const POP_DAMPING = 22;

/** Step response of the pop spring (0 -> 1) at `tSec`, analytic (frame-rate independent). */
export function popScale(tSec: number, k = POP_STIFFNESS, c = POP_DAMPING): number {
    if (!(tSec > 0)) return 0;
    const w = Math.sqrt(k);
    const z = c / (2 * w);
    if (z >= 1) return 1 - Math.exp(-w * tSec) * (1 + w * tSec);
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * tSec) * (Math.cos(wd * tSec) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * tSec));
}

/** Smoothstep 0..1. */
export function smoothstep01(t: number): number {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
}

/** Exit scale/alpha (1 -> 0 over EXIT_MS). */
export function exitFactor(sinceExpiryMs: number): number {
    return 1 - smoothstep01(sinceExpiryMs / EXIT_MS);
}

/**
 * Tail x offset (canvas px from the bubble centre) for a bubble slid sideways to stay in
 * frame: `frac` = pet offset from the bubble centre as a fraction of the canvas width.
 * Clamped so the tail never leaves the rounded rect's straight bottom edge.
 */
export function tailOffsetPx(frac: number, rectW: number, canvasW = 512, inset = 41): number {
    const max = Math.max(0, rectW / 2 - inset);
    const px = Number.isFinite(frac) ? frac * canvasW : 0;
    return Math.min(max, Math.max(-max, px));
}

/**
 * A cheap mouth flap for an unvoiced bubble: one Azure viseme per revealed
 * character (vowels open the mouth, b/m/p close it), timed with the typewriter.
 */
export function textVisemes(text: string, cps = REVEAL_CPS): VisemeEvent[] {
    const out: VisemeEvent[] = [];
    const step = 1000 / cps;
    const lower = chars(sanitizeBubbleText(text).toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""));
    for (const [i, ch] of lower.entries()) {
        const id = /[aă]/u.test(ch) ? 2 : ch === "e" ? 4 : /[iî]/u.test(ch) ? 6 : ch === "o" ? 8 : ch === "u" ? 7 : /[bmp]/u.test(ch) ? 21 : /[fv]/u.test(ch) ? 18 : /\p{L}/u.test(ch) ? 19 : 0;
        const prev = out.at(-1);
        if (prev && prev.id === id) continue;
        out.push({ id, offsetMs: Math.round(i * step) });
    }
    out.push({ id: 0, offsetMs: Math.round(lower.length * step) });
    return out;
}
