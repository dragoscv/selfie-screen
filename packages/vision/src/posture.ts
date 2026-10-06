import type { VisionCalibration } from "@tiksee/core";

import { at, dist, mid, type Pt } from "./geometry.js";
import type { Obs } from "./types.js";

/**
 * Posture from the 33 MediaPipe pose landmarks of one person, in display
 * pixels (upright camera pixels, mirrored like the preview). The calibration
 * stores `shoulderPx` and `neckRatio` in the SAME unit (upright camera pixels
 * at full camera resolution), captured by the wizard.
 *
 * `slouch` is exposed as a raw per-frame level; the 60 s hold lives in the
 * debouncer (`minOnMs`), like every other dwell.
 */
export const POSE = {
    NOSE: 0,
    LEFT_EYE: 2,
    RIGHT_EYE: 5,
    LEFT_EAR: 7,
    RIGHT_EAR: 8,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
} as const;

const vis = (p: Pt) => p.visibility ?? 1;
const seen = (p: Pt, min = 0.5) => vis(p) >= min;

export function shoulderWidth(lm: readonly Pt[]): number {
    return dist(at(lm, POSE.LEFT_SHOULDER), at(lm, POSE.RIGHT_SHOULDER));
}

/** Nose height above the shoulder line, as a fraction of the shoulder width. */
export function neckRatio(lm: readonly Pt[]): number {
    const sw = shoulderWidth(lm);
    if (sw <= 0) return 0;
    const sh = mid(at(lm, POSE.LEFT_SHOULDER), at(lm, POSE.RIGHT_SHOULDER));
    return (sh.y - at(lm, POSE.NOSE).y) / sw;
}

export interface PostureInput {
    /** Pose landmarks (33), or null when no person is detected. */
    lm: readonly Pt[] | null;
    /** Upright frame height in the same unit as the landmarks. */
    frameH: number;
}

type Cal = Pick<VisionCalibration, "shoulderPx" | "neckRatio">;

export class PostureAnalyzer {
    #cal: Cal;
    #lostSince: number | null = null;
    readonly #awayMs: number;

    constructor(calibration: Cal, awayMs = 3000) {
        this.#cal = calibration;
        this.#awayMs = awayMs;
    }

    setCalibration(c: Cal): void {
        this.#cal = c;
    }

    update({ lm, frameH }: PostureInput, tMs: number): Obs[] {
        if (!lm) {
            this.#lostSince ??= tMs;
            return tMs - this.#lostSince >= this.#awayMs ? [{ signal: "away", score: 0.9 }] : [];
        }
        this.#lostSince = null;
        const out: Obs[] = [];
        const ls = at(lm, POSE.LEFT_SHOULDER);
        const rs = at(lm, POSE.RIGHT_SHOULDER);
        if (!seen(ls) || !seen(rs)) return out;
        const sw = shoulderWidth(lm);
        const shoulderY = (ls.y + rs.y) / 2;

        // Lean: shoulder width vs calibrated baseline (±25 %).
        const base = this.#cal.shoulderPx;
        if (base > 0) {
            const r = sw / base;
            if (r > 1.25) out.push({ signal: "lean_in", score: Math.min(1, 0.5 + (r - 1.25)), value: r });
            if (r < 0.75) out.push({ signal: "lean_out", score: Math.min(1, 0.5 + (0.75 - r)), value: r });
        }

        // Slouch: neck ratio 15 % below the upright baseline.
        const nr = neckRatio(lm);
        if (this.#cal.neckRatio > 0 && seen(at(lm, POSE.NOSE)) && nr < this.#cal.neckRatio * 0.85) {
            out.push({ signal: "slouch", score: 0.75, value: nr });
        }

        // Standing vs sitting: standing shows hips AND knees, with a long torso and
        // the shoulders in the upper part of the frame.
        const lh = at(lm, POSE.LEFT_HIP);
        const rh = at(lm, POSE.RIGHT_HIP);
        const hipsSeen = seen(lh, 0.6) && seen(rh, 0.6);
        if (hipsSeen) {
            const hipY = (lh.y + rh.y) / 2;
            const torso = (hipY - shoulderY) / Math.max(sw, 1e-6);
            const knees = seen(at(lm, POSE.LEFT_KNEE), 0.6) && seen(at(lm, POSE.RIGHT_KNEE), 0.6);
            const kneeGap = knees ? (at(lm, POSE.LEFT_KNEE).y + at(lm, POSE.RIGHT_KNEE).y) / 2 - hipY : 0;
            const standing = knees && kneeGap > 0.8 * sw && torso > 1.1 && shoulderY < frameH * 0.45;
            out.push({ signal: standing ? "standing" : "sitting", score: 0.7 });
        } else {
            out.push({ signal: "sitting", score: 0.6 });
        }

        // Arms crossed: each wrist near the opposite elbow, both in front of the chest.
        const lw = at(lm, POSE.LEFT_WRIST);
        const rw = at(lm, POSE.RIGHT_WRIST);
        const le = at(lm, POSE.LEFT_ELBOW);
        const re = at(lm, POSE.RIGHT_ELBOW);
        if (seen(lw, 0.3) && seen(rw, 0.3) && seen(le, 0.3) && seen(re, 0.3)) {
            const crossed = dist(lw, re) < 0.6 * sw && dist(rw, le) < 0.6 * sw && lw.y > shoulderY && rw.y > shoulderY;
            if (crossed) out.push({ signal: "arms_crossed", score: 0.75 });
        }

        // Hand raised: a wrist above the eyes (one hand; two hands on the head is a separate signal).
        const nose = at(lm, POSE.NOSE);
        const eyeY = Math.min(at(lm, POSE.LEFT_EYE).y, at(lm, POSE.RIGHT_EYE).y);
        const headTop = eyeY - 0.35 * sw;
        const onHead = (w: Pt) => seen(w) && w.y < eyeY + 0.1 * sw && w.y > headTop - 0.4 * sw && Math.abs(w.x - nose.x) < 0.75 * sw;
        const both = onHead(lw) && onHead(rw);
        if (both) out.push({ signal: "hands_on_head", score: 0.75 });
        else {
            const raised = (w: Pt, e: Pt) => seen(w) && w.y < headTop && e.y < shoulderY;
            if (raised(lw, le)) out.push({ signal: "hand_raised", score: 0.8, hand: "left" });
            else if (raised(rw, re)) out.push({ signal: "hand_raised", score: 0.8, hand: "right" });
        }
        return out;
    }
}
