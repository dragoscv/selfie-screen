import type { CaptionSettings } from "@tiksee/core";
import { layoutBubble, sanitizeBubbleText } from "@tiksee/pets";

/**
 * Pure layout for the live caption strip (preview DOM and output canvas share the numbers):
 * line wrapping, pill size and the clamp that keeps the strip inside the frame.
 */

/** Strip height for one line at scale 1, as a share of the OUTPUT frame height. */
export const LINE_FRAC = 0.028;
/** Strip max width as a share of the output frame width at scale 1. */
export const MAX_WIDTH_FRAC = 0.86;
/** Safe margin from the frame edges (output-normalised). */
export const EDGE_SAFE = 0.03;

export interface CaptionText {
    /** Older final lines (dimmer), oldest first. */
    history: string[];
    /** The newest line: the current partial, else the newest final. */
    main: string;
    /** Translation of the newest final line, if any. */
    translated: string;
}

/** Chars per line from the width the strip may use (wider frame = longer lines). */
export function charsPerLine(frameAspect: number, scale: number): number {
    // ~0.55 em per char; em = LINE_FRAC * frameHeight * scale * 0.72.
    const widthPx = MAX_WIDTH_FRAC * frameAspect;
    const em = LINE_FRAC * scale * 0.72;
    return Math.max(14, Math.min(64, Math.floor(widthPx / (em * 0.55))));
}

/** Every wrapped row of `s` (no limit), code-point safe, emoji kept. */
function wrapAll(s: string, chars: number): string[] {
    return s.trim() ? layoutBubble(sanitizeBubbleText(s), chars, 1000) : [];
}

/**
 * The last `rows` rows of `s`: a long sentence scrolls up like a teleprompter so the newest
 * words are always on screen (a leading … marks the part that scrolled away).
 */
export function tailRows(s: string, chars: number, rows: number): string[] {
    const all = wrapAll(s, chars);
    if (all.length <= rows) return all;
    const out = all.slice(all.length - rows);
    out[0] = `… ${out[0] ?? ""}`;
    return out;
}

/** Wrap the strip: history one row each, the newest sentence and its translation as a scrolling tail. */
export function wrapCaption(text: CaptionText, chars: number, rows = 3): { history: string[]; main: string[]; translated: string[] } {
    return {
        history: text.history.flatMap((h) => (h.trim() ? layoutBubble(sanitizeBubbleText(h), chars, 1) : [])),
        main: tailRows(text.main, chars, rows),
        translated: tailRows(text.translated, chars, rows),
    };
}

/** Keep a strip of size (w, h) (output-normalised) centred near (u, v) fully inside the frame. */
export function clampCentre(u: number, v: number, w: number, h: number): { u: number; v: number } {
    const hx = Math.min(w / 2, 0.5 - EDGE_SAFE);
    const hy = Math.min(h / 2, 0.5 - EDGE_SAFE);
    return { u: Math.min(1 - EDGE_SAFE - hx, Math.max(EDGE_SAFE + hx, u)), v: Math.min(1 - EDGE_SAFE - hy, Math.max(EDGE_SAFE + hy, v)) };
}

export interface CaptionLook {
    bg: string;
    border: string;
    text: string;
    dim: string;
    accent: string;
    shadow: boolean;
}

export function captionLook(style: CaptionSettings["style"]): CaptionLook {
    switch (style) {
        case "solid":
            return { bg: "rgba(12,12,18,0.92)", border: "rgba(255,255,255,0.10)", text: "#ffffff", dim: "rgba(255,255,255,0.62)", accent: "#7dd3fc", shadow: false };
        case "minimal":
            return { bg: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)", text: "#ffffff", dim: "rgba(255,255,255,0.75)", accent: "#bae6fd", shadow: true };
        default:
            return { bg: "rgba(14,14,22,0.62)", border: "rgba(255,255,255,0.18)", text: "#ffffff", dim: "rgba(255,255,255,0.66)", accent: "#7dd3fc", shadow: true };
    }
}
