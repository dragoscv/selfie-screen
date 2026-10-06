import type { SignalId } from "@tiksee/core";

export type Side = "left" | "right";

/** A per-frame level observation (0..1); the debouncer turns levels into start/end edges. */
export interface Obs {
    signal: SignalId;
    /** 0..1; >= 0.5 means "on" with the default thresholds. */
    score: number;
    hand?: Side;
    value?: number;
}

/** A momentary detection (swipe, wink, nod...) that fires once. */
export interface Pulse {
    signal: SignalId;
    confidence: number;
    hand?: Side;
    value?: number;
}

/**
 * Map a raw detector value onto the debouncer's score scale so that
 * score >= 0.5 exactly when value >= threshold, and score < 0.35 roughly when
 * value < 0.7 * threshold (the release side of the hysteresis).
 */
export function toScore(value: number, threshold: number): number {
    const thr = Math.min(Math.max(threshold, 1e-3), 0.999);
    if (value >= thr) return Math.min(1, 0.5 + (0.5 * (value - thr)) / (1 - thr));
    return Math.max(0, (0.5 * value) / thr);
}
