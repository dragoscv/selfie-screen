import type { HandGesture } from "@tiksee/core";

import { at, dist, mean, type Pt } from "./geometry.js";
import type { Obs, Side } from "./types.js";

/**
 * Static hand shapes from the 21 MediaPipe hand landmarks.
 *
 * Input points are in display space (upright, mirrored like the preview,
 * pixels; see geometry.ts), so `point_left` means "points to the left of the
 * streamer's own preview". `side` is the subject's real hand. Every distance
 * is normalised by the palm size (wrist -> middle MCP) so the thresholds hold
 * at any distance from the camera.
 */

export const HAND = {
    WRIST: 0,
    THUMB_CMC: 1,
    THUMB_MCP: 2,
    THUMB_IP: 3,
    THUMB_TIP: 4,
    INDEX_MCP: 5,
    INDEX_PIP: 6,
    INDEX_TIP: 8,
    MIDDLE_MCP: 9,
    MIDDLE_PIP: 10,
    MIDDLE_TIP: 12,
    RING_MCP: 13,
    RING_PIP: 14,
    RING_TIP: 16,
    PINKY_MCP: 17,
    PINKY_PIP: 18,
    PINKY_TIP: 20,
} as const;

/** [thumb, index, middle, ring, pinky] */
export type FingerFlags = [boolean, boolean, boolean, boolean, boolean];

export interface HandShape {
    side: Side;
    /** Extended fingers, thumb first. */
    extended: FingerFlags;
    fingers: number;
    /** Best named shape, or null when nothing specific matches. */
    shape: HandGesture | null;
    /** 0..1 confidence of `shape`. */
    confidence: number;
    /** Wrist -> middle MCP length in input units. */
    palm: number;
    /** Mean of wrist + the four finger MCPs, input units. */
    centre: Pt;
}

/** MediaPipe canned gesture categories -> our ids. */
export const CANNED_GESTURES: Readonly<Record<string, HandGesture | null>> = {
    None: null,
    Thumb_Up: "thumb_up",
    Thumb_Down: "thumb_down",
    Open_Palm: "open_palm",
    Closed_Fist: "fist",
    Victory: "victory",
    ILoveYou: "i_love_you",
    Pointing_Up: "point_up",
};

export function mapCanned(category: string): HandGesture | null {
    return CANNED_GESTURES[category] ?? null;
}

export function palmSize(lm: readonly Pt[]): number {
    return Math.max(dist(at(lm, HAND.WRIST), at(lm, HAND.MIDDLE_MCP)), 1e-6);
}

function angleAt(a: Pt, b: Pt, c: Pt): number {
    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (n === 0) return Math.PI;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n)));
}

/**
 * Per-finger extension. Long fingers: the tip is clearly farther from the wrist
 * than the PIP joint. Thumb: rotation- and handedness-independent test — the
 * thumb is straight at the IP joint and its tip is away from the index MCP and
 * the palm (a folded thumb lies across the palm, next to the index base).
 */
export function fingerExtension(lm: readonly Pt[]): FingerFlags {
    const wrist = at(lm, HAND.WRIST);
    const palm = palmSize(lm);
    const long = (pip: number, tip: number): boolean => dist(at(lm, tip), wrist) > dist(at(lm, pip), wrist) * 1.12;
    const tTip = at(lm, HAND.THUMB_TIP);
    const straight = angleAt(at(lm, HAND.THUMB_MCP), at(lm, HAND.THUMB_IP), tTip) > (150 * Math.PI) / 180;
    const awayFromIndex = dist(tTip, at(lm, HAND.INDEX_MCP)) / palm > 0.55;
    const awayFromPinky = dist(tTip, at(lm, HAND.PINKY_MCP)) > dist(at(lm, HAND.THUMB_IP), at(lm, HAND.PINKY_MCP));
    return [
        straight && awayFromIndex && awayFromPinky,
        long(HAND.INDEX_PIP, HAND.INDEX_TIP),
        long(HAND.MIDDLE_PIP, HAND.MIDDLE_TIP),
        long(HAND.RING_PIP, HAND.RING_TIP),
        long(HAND.PINKY_PIP, HAND.PINKY_TIP),
    ];
}

const pattern = (e: FingerFlags, want: string): boolean =>
    // want: 5 chars of 1 (extended), 0 (folded), ? (either), thumb first.
    [...want].every((c, i) => c === "?" || (c === "1") === e[i]);

/** Classify one hand. `canned` = MediaPipe's top canned category (+score), when available. */
export function classifyHand(lm: readonly Pt[], side: Side, canned?: { category: string; score: number }): HandShape {
    const palm = palmSize(lm);
    const extended = fingerExtension(lm);
    const fingers = extended.filter(Boolean).length;
    const centre = mean([HAND.WRIST, HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP].map((i) => at(lm, i)));
    const pinchD = dist(at(lm, HAND.THUMB_TIP), at(lm, HAND.INDEX_TIP)) / palm;
    // In a fist the folded thumb tip rests next to the index base; in a pinch/ok it is out at the fingertip.
    const thumbOut = dist(at(lm, HAND.THUMB_TIP), at(lm, HAND.INDEX_MCP)) / palm > 0.5;

    let shape: HandGesture | null = null;
    let confidence = 0;
    const set = (s: HandGesture, c: number) => {
        shape = s;
        confidence = c;
    };

    if (thumbOut && pinchD < 0.3 && pattern(extended, "??111")) set("ok", 0.85);
    else if (thumbOut && pinchD < 0.25 && !extended[2]) set("pinch", 0.8);
    else if (pattern(extended, "01001")) set("rock", 0.85);
    else if (pattern(extended, "11001")) set("i_love_you", 0.85);
    else if (pattern(extended, "10001")) set("call_me", 0.85);
    else if (pattern(extended, "?1100")) set("victory", 0.8);
    else if (pattern(extended, "?1000")) {
        const base = at(lm, HAND.INDEX_MCP);
        const tip = at(lm, HAND.INDEX_TIP);
        const dx = tip.x - base.x;
        const dy = tip.y - base.y;
        if (-dy > Math.abs(dx)) set("point_up", 0.8);
        else if (Math.abs(dx) > Math.abs(dy)) set(dx < 0 ? "point_left" : "point_right", 0.8);
    } else if (pattern(extended, "10000")) {
        const base = at(lm, HAND.THUMB_MCP);
        const tip = at(lm, HAND.THUMB_TIP);
        const dy = tip.y - base.y;
        const dx = tip.x - base.x;
        if (Math.abs(dy) > Math.abs(dx) * 1.2) set(dy < 0 ? "thumb_up" : "thumb_down", 0.8);
    } else if (fingers === 5) set("open_palm", 0.8);
    else if (fingers === 0) set("fist", 0.8);

    // MediaPipe's canned classifier is better at the shapes it knows; ours win on
    // the shapes it does not have (ok, pinch, rock, call_me, point left/right).
    const specific = shape === "ok" || shape === "pinch" || shape === "rock" || shape === "call_me" || shape === "point_left" || shape === "point_right";
    const mapped = canned ? mapCanned(canned.category) : null;
    if (canned && mapped && canned.score >= 0.6 && !specific) set(mapped, Math.min(1, canned.score));
    else if (canned && canned.category === "None" && canned.score >= 0.8 && !specific && shape !== null) confidence *= 0.75;

    return { side, extended, fingers, shape, confidence, palm, centre };
}

/** Per-frame observations for one hand: the named shape + the finger count. */
export function handObservations(h: HandShape): Obs[] {
    const out: Obs[] = [{ signal: `fingers_${h.fingers}` as HandGesture, score: 0.9, hand: h.side, value: h.fingers }];
    if (h.shape) out.push({ signal: h.shape, score: h.confidence, hand: h.side });
    return out;
}
