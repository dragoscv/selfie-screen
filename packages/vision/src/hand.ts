import type { HandGesture } from "@tiksee/core";

import { OneEuroFilter } from "./depth.js";
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

/**
 * Normalisation scale for shape thresholds: max(palm, half the hand extent). A palm tilted
 * towards the camera foreshortens wrist -> middle MCP; the extent (largest distance between any
 * two landmarks — a rotation-invariant stand-in for the bounding-box diagonal) keeps the scale.
 */
export function handScale(lm: readonly Pt[]): number {
    let extent = 0;
    for (let i = 0; i < lm.length; i++) for (let j = i + 1; j < lm.length; j++) extent = Math.max(extent, dist(at(lm, i), at(lm, j)));
    return Math.max(palmSize(lm), 0.5 * extent);
}

/** 3D point (MediaPipe hand WORLD landmark, metres). */
export interface Pt3 {
    x: number;
    y: number;
    z: number;
}

const d3 = (a: Pt3 | undefined, b: Pt3 | undefined): number => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : NaN);

/**
 * Thumb tip - index tip distance / palm width (index MCP -> pinky MCP), from the 21 hand WORLD
 * landmarks (3D, so independent of rotation and distance). NaN when the landmarks are missing.
 */
export function worldPinchRatio(world: readonly Pt3[]): number {
    const palm = d3(world[HAND.INDEX_MCP], world[HAND.PINKY_MCP]);
    if (!(palm > 1e-6)) return NaN;
    return d3(world[HAND.THUMB_TIP], world[HAND.INDEX_TIP]) / palm;
}

const FINGERTIPS = [HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP] as const;

/**
 * Off-frame gating on frame-normalised landmarks (0..1, any orientation): the wrist must lie in
 * [margin, 1 - margin] on both axes and at most 2 fingertips may fall outside that range.
 * Outside it MediaPipe still returns 21 points, but they are partly invented.
 */
export function handInFrame(lm: readonly Pt[], margin = 0.01): boolean {
    if (lm.length < 21) return false;
    const inside = (p: Pt) => p.x >= margin && p.x <= 1 - margin && p.y >= margin && p.y <= 1 - margin;
    if (!inside(at(lm, HAND.WRIST))) return false;
    return FINGERTIPS.filter((i) => !inside(at(lm, i))).length <= 2;
}

export interface HandSmootherOptions {
    minCutoff: number;
    beta: number;
    dCutoff: number;
    /** Gap after which the filter restarts from the next sample, ms. */
    resetMs: number;
}

/**
 * One-Euro filter on all landmarks of one hand (x and y independently). Units: frame-normalised
 * coords (0..1), so beta is per (unit / s). minCutoff 1.5 Hz: a still hand with ±0.0025 detector
 * jitter at 30 fps moves < 0.002 per frame (test); beta 0.5 opens the filter for real movement
 * (a 2 frame/s swipe -> ~2.5 Hz) so swipes keep most of their speed.
 */
export class HandSmoother {
    readonly #o: HandSmootherOptions;
    #fx: OneEuroFilter[] = [];
    #fy: OneEuroFilter[] = [];
    #last = -Infinity;

    constructor(options: Partial<HandSmootherOptions> = {}) {
        this.#o = { minCutoff: 1.5, beta: 0.5, dCutoff: 1, resetMs: 200, ...options };
    }

    smooth(lm: readonly Pt[], tMs: number): Pt[] {
        const o = this.#o;
        if (tMs - this.#last > o.resetMs || this.#fx.length !== lm.length) {
            this.#fx = lm.map(() => new OneEuroFilter(o.minCutoff, o.beta, o.dCutoff));
            this.#fy = lm.map(() => new OneEuroFilter(o.minCutoff, o.beta, o.dCutoff));
        }
        this.#last = tMs;
        return lm.map((p, i) => ({ ...p, x: this.#fx[i]?.filter(p.x, tMs) ?? p.x, y: this.#fy[i]?.filter(p.y, tMs) ?? p.y }));
    }

    reset(): void {
        this.#fx = [];
        this.#fy = [];
        this.#last = -Infinity;
    }
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
    const palm = handScale(lm);
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

export interface ClassifyOptions {
    /** Thumb-index / palm-width ratio from the hand WORLD landmarks (see worldPinchRatio). */
    pinchRatio?: number;
    /** Personal threshold for `pinchRatio` (calibration.hands.pinchOn, or pinchOff while pinching). Default 0.2. */
    pinchOn?: number;
}

/**
 * Classify one hand. `canned` = MediaPipe's top canned category (+score), when available.
 * With `options.pinchRatio` the thumb-index closure uses that 3D ratio against `pinchOn`
 * instead of the 2D image-distance rules (0.3 ok / 0.25 pinch).
 */
export function classifyHand(lm: readonly Pt[], side: Side, canned?: { category: string; score: number }, options: ClassifyOptions = {}): HandShape {
    const palm = palmSize(lm);
    const scale = handScale(lm);
    const extended = fingerExtension(lm);
    const fingers = extended.filter(Boolean).length;
    const centre = mean([HAND.WRIST, HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP].map((i) => at(lm, i)));
    const pinchD = dist(at(lm, HAND.THUMB_TIP), at(lm, HAND.INDEX_TIP)) / scale;
    // In a fist the folded thumb tip rests next to the index base; in a pinch/ok it is out at the fingertip.
    const thumbOut = dist(at(lm, HAND.THUMB_TIP), at(lm, HAND.INDEX_MCP)) / scale > 0.5;
    const ratio = options.pinchRatio;
    const world = ratio !== undefined && Number.isFinite(ratio);
    const on = options.pinchOn ?? 0.2;
    const closedOk = thumbOut && (world ? ratio < on : pinchD < 0.3);
    const closedPinch = thumbOut && (world ? ratio < on : pinchD < 0.25);

    let shape: HandGesture | null = null;
    let confidence = 0;
    const set = (s: HandGesture, c: number) => {
        shape = s;
        confidence = c;
    };

    // ok and pinch are disjoint by the middle finger alone: ok = middle+ring+pinky extended, pinch = middle folded.
    if (closedOk && pattern(extended, "??111")) set("ok", 0.85);
    else if (closedPinch && !extended[2]) set("pinch", 0.8);
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
