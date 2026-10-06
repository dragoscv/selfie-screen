import { at, dist, mid, type Pt } from "./geometry.js";
import { HAND, type HandShape } from "./hand.js";
import type { Obs, Pulse } from "./types.js";

/**
 * Two-hand gestures for one person. Points are display space (see geometry.ts).
 * Static shapes (heart, frame, timeout, prayer) are per-frame levels; clap is a
 * pulse; spread/squeeze are levels while the hands move apart/together fast.
 */
export interface HandInput {
    shape: HandShape;
    lm: readonly Pt[];
}

interface Sample {
    t: number;
    /** Wrist distance in palm units. */
    d: number;
}

const HISTORY_MS = 1000;
const RATE_WINDOW_MS = 400;

function direction(lm: readonly Pt[]): Pt {
    const w = at(lm, HAND.WRIST);
    const m = at(lm, HAND.MIDDLE_TIP);
    const n = Math.max(Math.hypot(m.x - w.x, m.y - w.y), 1e-6);
    return { x: (m.x - w.x) / n, y: (m.y - w.y) / n };
}

export function isHeart(a: HandInput, b: HandInput): boolean {
    const palm = (a.shape.palm + b.shape.palm) / 2;
    const thumbs = dist(at(a.lm, HAND.THUMB_TIP), at(b.lm, HAND.THUMB_TIP)) / palm;
    const index = dist(at(a.lm, HAND.INDEX_TIP), at(b.lm, HAND.INDEX_TIP)) / palm;
    const indexY = mid(at(a.lm, HAND.INDEX_TIP), at(b.lm, HAND.INDEX_TIP)).y;
    const thumbY = mid(at(a.lm, HAND.THUMB_TIP), at(b.lm, HAND.THUMB_TIP)).y;
    // The heart's lobes (index tips) are above its point (thumb tips), hands apart at the wrists.
    const wrists = dist(at(a.lm, HAND.WRIST), at(b.lm, HAND.WRIST)) / palm;
    return thumbs < 0.4 && index < 0.4 && indexY < thumbY - 0.3 * palm && wrists > 0.8;
}

/** Director's frame: both hands show thumb + index ("L"), others folded, hands far apart diagonally. */
export function isFrame(a: HandInput, b: HandInput): boolean {
    const l = (h: HandShape) => h.extended[0] && h.extended[1] && !h.extended[2] && !h.extended[3] && !h.extended[4];
    if (!l(a.shape) || !l(b.shape)) return false;
    const palm = (a.shape.palm + b.shape.palm) / 2;
    const dx = Math.abs(a.shape.centre.x - b.shape.centre.x) / palm;
    const dy = Math.abs(a.shape.centre.y - b.shape.centre.y) / palm;
    return dx > 1.5 && dy > 0.6;
}

/** "T": one flat hand horizontal, the other vertical with its fingertips under the flat palm's centre. */
export function isTimeout(a: HandInput, b: HandInput): boolean {
    const check = (flat: HandInput, stem: HandInput): boolean => {
        if (flat.shape.fingers < 4 || stem.shape.fingers < 4) return false;
        const df = direction(flat.lm);
        const ds = direction(stem.lm);
        if (Math.abs(df.x) < 0.8 || Math.abs(ds.y) < 0.8) return false;
        const tip = at(stem.lm, HAND.MIDDLE_TIP);
        return dist(tip, flat.shape.centre) / flat.shape.palm < 0.9;
    };
    return check(a, b) || check(b, a);
}

/** Palms pressed together, fingers up. */
export function isPrayer(a: HandInput, b: HandInput): boolean {
    if (a.shape.fingers < 4 || b.shape.fingers < 4) return false;
    const palm = (a.shape.palm + b.shape.palm) / 2;
    const tips = dist(at(a.lm, HAND.MIDDLE_TIP), at(b.lm, HAND.MIDDLE_TIP)) / palm;
    const wrists = dist(at(a.lm, HAND.WRIST), at(b.lm, HAND.WRIST)) / palm;
    const up = direction(a.lm).y < -0.6 && direction(b.lm).y < -0.6;
    return tips < 0.45 && wrists < 0.9 && up;
}

export class TwoHandAnalyzer {
    #history: Sample[] = [];
    #lastClap = -Infinity;
    #wideAt = -Infinity;

    /** Feed both hands of one person (or null when they do not have two hands in view). */
    update(a: HandInput | null, b: HandInput | null, tMs: number): { obs: Obs[]; pulses: Pulse[] } {
        const obs: Obs[] = [];
        const pulses: Pulse[] = [];
        if (!a || !b) {
            this.#history = [];
            return { obs, pulses };
        }
        if (isHeart(a, b)) obs.push({ signal: "heart", score: 0.85 });
        if (isFrame(a, b)) obs.push({ signal: "frame", score: 0.8 });
        if (isTimeout(a, b)) obs.push({ signal: "timeout", score: 0.8 });
        if (isPrayer(a, b)) obs.push({ signal: "prayer", score: 0.8 });

        const palm = (a.shape.palm + b.shape.palm) / 2;
        const d = dist(a.shape.centre, b.shape.centre) / palm;
        this.#history.push({ t: tMs, d });
        while (this.#history.length > 0 && tMs - (this.#history[0]?.t ?? tMs) > HISTORY_MS) this.#history.shift();

        // Clap: hands were apart (> 1.6 palms) within the last 400 ms and now meet (< 0.8).
        if (d > 1.6) this.#wideAt = tMs;
        if (d < 0.8 && tMs - this.#wideAt < 400 && tMs - this.#lastClap > 250) {
            this.#lastClap = tMs;
            this.#wideAt = -Infinity;
            pulses.push({ signal: "clap", confidence: 0.8 });
        }

        // Spread / squeeze: distance ratio over the last ~400 ms.
        const past = this.#history.find((s) => tMs - s.t <= RATE_WINDOW_MS);
        if (past && tMs - past.t >= RATE_WINDOW_MS * 0.5 && past.d > 0) {
            const ratio = d / past.d;
            if (ratio > 1.4 && d > 2) obs.push({ signal: "spread", score: Math.min(1, 0.5 + (ratio - 1.4)), value: ratio });
            if (ratio < 0.7 && past.d > 1.5) obs.push({ signal: "squeeze", score: Math.min(1, 0.5 + (0.7 - ratio)), value: ratio });
        }
        return { obs, pulses };
    }

    reset(): void {
        this.#history = [];
        this.#wideAt = -Infinity;
    }
}
