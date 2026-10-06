import { OneEuroPoint, focalFromVfov, solveRootTranslation, unproject, depthOf, type BodySnapshot, type Pinhole, type SolveJoint, type Vec3 } from "@tiksee/pets";

import type { DebugHand, OwnerHand } from "./controller.js";

/**
 * Owner hands in the ROOM frame (metres), from one camera (decision Q53):
 *  1. 21-point solve of the hand's translation: MediaPipe hand WORLD landmarks
 *     (metric shape, origin = hand centre) against the image landmarks (raw px),
 *     scaled by the owner's calibrated palm width when known;
 *  2. anchored to the pose wrist of the same side (whose depth comes from the
 *     metric body solve + Kalman): a solve more than 0.25 m away is replaced
 *     by the wrist depth ("wrist" source), never trusted blindly;
 *  3. One-Euro on every landmark and on the pinch point, pinch with hysteresis
 *     (on < pinchOn, off > pinchOff, in palm widths) on a median-of-3 ratio,
 *     released only after 200 ms open, and a 50 ms freeze of the pinch point at
 *     onset (closing the fingers moves the midpoint).
 *  4. Hand results arrive at ~8-15 Hz: every render frame interpolates the
 *     landmarks between the last two results, half a result interval behind
 *     (max 60 ms) with a capped 25 % extrapolation, so the skeleton and the
 *     pets move fluidly without adding a full interval of lag.
 * Output feeds PetStage.setHands (grab / resize) and the F3 overlay.
 */

// Units are metres: a moving hand is ~0.3-1 m/s, so beta must be several Hz per m/s to open
// the filter while moving (0.6 kept ~100 ms of lag at 8-15 Hz). Still jitter is handled by
// minCutoff; render-time interpolation provides the visual smoothness.
const HAND_FILTER = { minCutoff: 2.5, beta: 6, dCutoff: 1 };
const POINT_FILTER = { minCutoff: 2, beta: 6, dCutoff: 1 };
/** Apparent hand size (px): heavier smoothing, a deliberate push/pull takes ~0.3 s anyway. */
const SIZE_FILTER = { minCutoff: 1, beta: 0.02, dCutoff: 1 };
/** A solve this far (m) from the pose wrist depth is rejected. */
export const WRIST_GATE_M = 0.25;
/** Hand unseen this long = not present (results arrive every 70-250 ms). */
export const HAND_LOST_MS = 400;
/** Interpolation delay bounds (ms) behind the newest result. */
const MIN_DELAY_MS = 15;
const MAX_DELAY_MS = 60;
/** How far past the newest result the segment may be extended (fraction of a segment). */
const MAX_EXTRAPOLATE = 0.25;
/** Pinch point frozen this long at pinch onset. */
export const PINCH_FREEZE_MS = 50;
/** A pinch ends only after the ratio stayed above pinchOff this long. */
export const PINCH_RELEASE_MS = 200;
/** MediaPipe's average palm width (index MCP -> pinky MCP) in its world landmarks is used when uncalibrated. */
const PALM = { indexMcp: 5, pinkyMcp: 17, wrist: 0, thumbTip: 4, indexTip: 8 } as const;

export interface HandSpaceConfig {
    /** Vertical FOV of the RAW camera frame (deg). */
    cameraVfovDeg: number;
    /** Calibrated palm width (m), 0 = MediaPipe's average hand. */
    palmM: number;
    pinchOn: number;
    pinchOff: number;
}

/** Maps a RAW-normalised point to output-normalised (u, v). */
export type RawToOutput = (x: number, y: number) => [number, number];

interface SideState {
    lm: OneEuroPoint;
    point: OneEuroPoint;
    pinching: boolean;
    pinchSince: number;
    frozen: Vec3 | null;
    lastSeen: number;
    lastT: number;
    out: DebugHand | null;
    palmEstimates: number[];
    /** Newest two results (arrival time, landmarks, point) for render-time interpolation. */
    prev: { at: number; lm: Vec3[]; point: Vec3 } | null;
    cur: { at: number; lm: Vec3[]; point: Vec3 } | null;
    /** Smoothed inter-arrival interval (ms). */
    interval: number;
    /** Hand wrist - body wrist (m), low-passed: the hand rides the body's interpolated wrist. */
    corr: Vec3 | null;
    /** Last pinch ratios (median filter) and when the ratio first went above pinchOff. */
    ratios: number[];
    releaseSince: number | null;
    /** Apparent hand size filter (px). */
    size: OneEuroPoint;
}

/** Low-pass weight per hand result for the hand-to-body wrist offset. */
const CORR_ALPHA = 0.35;
/** Offsets larger than this (m) mean the pose wrist is wrong for this hand: do not anchor. */
const CORR_MAX_M = 0.15;

function bodyWrist(body: BodySnapshot | null, side: "left" | "right"): Vec3 | null {
    const j = body?.present ? (side === "left" ? body.joints.leftWrist : body.joints.rightWrist) : null;
    return j && j.conf > 0.5 ? j.p : null;
}

/** Pinch strength 0..1 from the thumb-index / palm ratio (1 = touching). */
export function pinchStrength(ratio: number, pinchOff: number): number {
    const lo = 0.05;
    return Math.min(1, Math.max(0, 1 - (ratio - lo) / Math.max(pinchOff - lo, 1e-3)));
}

/**
 * Palm perches (room frame) from the tracked hands: centre = mean of the wrist and the four
 * knuckles, up = palm normal turned towards the camera / sky, open = an open-hand shape and no
 * pinch. `side` is the IMAGE side (smaller x = left), matching the handL / handR anchors.
 */
export function palmPerches(hands: readonly DebugHand[], cameraPos: Vec3): { side: "left" | "right"; centre: Vec3; up: Vec3; open: boolean }[] {
    const live = hands.filter((h) => h.present && h.landmarks.length >= 21);
    const out = live.map((h) => {
        const ids = [0, 5, 9, 13, 17];
        const c: Vec3 = [0, 0, 0];
        for (const i of ids) {
            const p = h.landmarks[i] as Vec3;
            c[0] += p[0] / ids.length;
            c[1] += p[1] / ids.length;
            c[2] += p[2] / ids.length;
        }
        const w = h.landmarks[0] as Vec3;
        const a = h.landmarks[5] as Vec3;
        const b = h.landmarks[17] as Vec3;
        const u: Vec3 = [a[0] - w[0], a[1] - w[1], a[2] - w[2]];
        const v: Vec3 = [b[0] - w[0], b[1] - w[1], b[2] - w[2]];
        let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        n = [n[0] / len, n[1] / len, n[2] / len];
        // Face the side the camera sees (the palm shown to the camera), then bias upwards.
        const toCam: Vec3 = [cameraPos[0] - c[0], cameraPos[1] - c[1], cameraPos[2] - c[2]];
        if (n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2] < 0) n = [-n[0], -n[1], -n[2]];
        const open = !h.pinching && (h.shape === "open_palm" || h.shape === "fingers_5" || h.shape === "fingers_4");
        return { centre: c, up: n, open, x: c[0] };
    });
    // Image side by x order (two hands), else by sign relative to the camera axis.
    const sorted = [...out].sort((p, q) => p.x - q.x);
    return sorted.map((p, i) => ({ side: sorted.length === 2 ? (i === 0 ? "left" : "right") : p.x < 0 ? "left" : "right", centre: p.centre, up: p.up, open: p.open }));
}

/** Pinch hysteresis: enter below `on`, leave above `off`. */
export function nextPinch(pinching: boolean, ratio: number, on: number, off: number): boolean {
    return pinching ? ratio < off : ratio < on;
}

/**
 * Translate the (shape-correct) hand so its wrist sits on the body's interpolated wrist plus
 * the filtered offset: the hand then moves on the same clock as the body skeleton and the pets
 * (BodyModel's adaptive-delay interpolation), and only its finger shape comes from the slower
 * hand tracker. Without a trusted body wrist the hand keeps its own position.
 */
function anchorToBody(h: { landmarks: Vec3[]; point: Vec3 } | Record<string, never>, wrist: Vec3 | null, corr: Vec3 | null): { landmarks: Vec3[]; point: Vec3 } | Record<string, never> {
    if (!("landmarks" in h) || !wrist || !corr) return h;
    const w0 = h.landmarks[PALM.wrist];
    if (!w0) return h;
    const d: Vec3 = [wrist[0] + corr[0] - w0[0], wrist[1] + corr[1] - w0[1], wrist[2] + corr[2] - w0[2]];
    const move = (p: Vec3): Vec3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    return { landmarks: h.landmarks.map(move), point: move(h.point) };
}

/**
 * Landmarks/point at `nowMs - delay`, between the last two results. delay = half a result
 * interval (latency matters more than perfect continuity), with a short capped extrapolation
 * past the newest result so the hand keeps moving until the next one lands. While pinching
 * the point is the newest one (grabbing wants the lowest latency).
 */
function interpolate(s: { prev: { at: number; lm: Vec3[]; point: Vec3 } | null; cur: { at: number; lm: Vec3[]; point: Vec3 } | null; interval: number; pinching: boolean }, nowMs: number): { landmarks: Vec3[]; point: Vec3 } | Record<string, never> {
    const { prev, cur } = s;
    if (!cur) return {};
    if (!prev || cur.at <= prev.at) return { landmarks: cur.lm, point: cur.point };
    const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, s.interval * 0.5));
    const k = Math.min(1 + MAX_EXTRAPOLATE, Math.max(0, (nowMs - delay - prev.at) / (cur.at - prev.at)));
    const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    return { landmarks: cur.lm.map((p, i) => mix(prev.lm[i] ?? p, p)), point: s.pinching ? cur.point : mix(prev.point, cur.point) };
}

/**
 * Camera-frame points (x right, y DOWN, z forward, metres) of the 21 landmarks: solve when
 * possible, else null. `scale` multiplies the world landmarks (personal palm size).
 */
export function solveHand(h: OwnerHand, rawW: number, rawH: number, cameraVfovDeg: number, scale: number): { cam: Vec3[]; residualPx: number } | null {
    if (h.world.length < 21 || h.raw.length < 21) return null;
    const fPx = focalFromVfov(cameraVfovDeg, rawH);
    const k = { fPx, cx: rawW / 2, cy: rawH / 2 };
    const joints: SolveJoint[] = [];
    for (let i = 0; i < 21; i++) {
        const im = h.raw[i];
        const w = h.world[i];
        if (!im || !w) continue;
        if (im.x < 0.005 || im.x > 0.995 || im.y < 0.005 || im.y > 0.995) continue;
        joints.push({ u: im.x * rawW, v: im.y * rawH, world: [w.x * scale, w.y * scale, w.z * scale], weight: 1 });
    }
    const r = solveRootTranslation(joints, k);
    if (!r) return null;
    const [tx, ty, tz] = r.t;
    return { cam: h.world.map((w) => [w.x * scale + tx, w.y * scale + ty, w.z * scale + tz] as Vec3), residualPx: r.residualPx };
}

/** Palm width (m) of the MediaPipe world landmarks (index MCP -> pinky MCP). */
export function worldPalm(h: OwnerHand): number {
    const a = h.world[PALM.indexMcp];
    const b = h.world[PALM.pinkyMcp];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;
}

export class HandSpace {
    readonly #sides = new Map<"left" | "right", SideState>();
    #sampling: number[] | null = null;

    #state(side: "left" | "right"): SideState {
        let s = this.#sides.get(side);
        if (!s) {
            s = {
                lm: new OneEuroPoint(63, HAND_FILTER),
                point: new OneEuroPoint(3, POINT_FILTER),
                pinching: false,
                pinchSince: 0,
                frozen: null,
                lastSeen: -Infinity,
                lastT: -Infinity,
                out: null,
                palmEstimates: [],
                prev: null,
                cur: null,
                interval: 100,
                corr: null,
                ratios: [],
                releaseSince: null,
                size: new OneEuroPoint(1, SIZE_FILTER),
            };
            this.#sides.set(side, s);
        }
        return s;
    }

    /** Start collecting palm-width estimates (m) for the gesture calibration. */
    startPalmSampling(): void {
        this.#sampling = [];
    }

    /** Median palm width (m) collected since `startPalmSampling`, 0 when none. */
    stopPalmSampling(): number {
        const v = this.#sampling ?? [];
        this.#sampling = null;
        if (!v.length) return 0;
        const s = [...v].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)] ?? 0;
    }

    /**
     * Feed the newest owner hands (only when `tMs` is new) and advance to `nowMs`.
     * `toOutput` maps raw -> output coords (crop, zoom, rotation, mirror) for `pin`.
     */
    update(
        nowMs: number,
        result: { tMs: number; hands: readonly OwnerHand[]; rawW: number; rawH: number } | null,
        body: BodySnapshot | null,
        pin: Pinhole,
        toOutput: RawToOutput,
        cfg: HandSpaceConfig,
    ): readonly DebugHand[] {
        if (result) {
            for (const h of result.hands) {
                if (h.stale) continue;
                const s = this.#state(h.side);
                if (result.tMs <= s.lastT) continue;
                s.lastT = result.tMs;
                this.#measure(s, h, result, body, pin, toOutput, cfg, nowMs);
            }
        }
        const out: DebugHand[] = [];
        for (const [, s] of this.#sides) {
            if (!s.out) continue;
            const present = nowMs - s.lastSeen < HAND_LOST_MS;
            if (!present) {
                s.pinching = false;
                s.frozen = null;
                s.ratios = [];
                s.releaseSince = null;
                if (nowMs - s.lastSeen > 400) {
                    s.lm.reset();
                    s.point.reset();
                    s.size.reset();
                    s.prev = null;
                    s.cur = null;
                    s.corr = null;
                }
            }
            const lerped = anchorToBody(interpolate(s, nowMs), bodyWrist(body, s.out.side), s.corr);
            s.out = { ...s.out, ...lerped, present, pinching: present && s.pinching };
            out.push(s.out);
        }
        return out;
    }

    #measure(
        s: SideState,
        h: OwnerHand,
        r: { tMs: number; rawW: number; rawH: number },
        body: BodySnapshot | null,
        pin: Pinhole,
        toOutput: RawToOutput,
        cfg: HandSpaceConfig,
        nowMs: number,
    ): void {
        const wp = worldPalm(h);
        const scale = cfg.palmM > 0 && wp > 0.02 ? cfg.palmM / wp : 1;
        const solved = solveHand(h, r.rawW, r.rawH, cfg.cameraVfovDeg, scale);
        // Pose wrist of the same side (subject's anatomical side) as the depth anchor.
        const wristJoint = body?.present ? (h.side === "left" ? body.joints.leftWrist : body.joints.rightWrist) : null;
        const wristDepth = wristJoint && wristJoint.conf > 0.5 ? depthOf(pin, wristJoint.p) : null;
        let depths: number[];
        let source: DebugHand["source"] = "solve";
        const solvedWrist = solved?.cam[PALM.wrist]?.[2];
        if (solved && solvedWrist !== undefined && (wristDepth === null || Math.abs(solvedWrist - wristDepth) <= WRIST_GATE_M)) {
            depths = solved.cam.map((c) => c[2]);
        } else if (wristDepth !== null) {
            // Relative finger depth from the hand model, absolute depth from the body.
            const w0 = h.world[PALM.wrist]?.z ?? 0;
            depths = h.world.map((w) => wristDepth + (w.z - w0) * scale);
            source = "wrist";
        } else return;
        // Palm-width estimate for calibration: image width at the wrist depth.
        const a = h.raw[PALM.indexMcp];
        const b = h.raw[PALM.pinkyMcp];
        if (this.#sampling && a && b && wristDepth !== null && h.inFrame) {
            const px = Math.hypot((a.x - b.x) * r.rawW, (a.y - b.y) * r.rawH);
            const fPx = focalFromVfov(cfg.cameraVfovDeg, r.rawH);
            const m = (px * wristDepth) / fPx;
            if (m > 0.04 && m < 0.14) this.#sampling.push(m);
        }
        const pts: number[] = [];
        for (let i = 0; i < 21; i++) {
            const im = h.raw[i];
            const d = depths[i] ?? depths[0] ?? 1;
            if (!im) {
                pts.push(0, 0, 0);
                continue;
            }
            const [u, v] = toOutput(im.x, im.y);
            const p = unproject(pin, u, v, Math.max(0.15, d));
            pts.push(p[0], p[1], p[2]);
        }
        const f = s.lm.filter(pts, r.tMs);
        const landmarks: Vec3[] = [];
        for (let i = 0; i < 21; i++) landmarks.push([f[i * 3] ?? 0, f[i * 3 + 1] ?? 0, f[i * 3 + 2] ?? 0]);
        const thumb = landmarks[PALM.thumbTip] as Vec3;
        const index = landmarks[PALM.indexTip] as Vec3;
        const mid: Vec3 = [(thumb[0] + index[0]) / 2, (thumb[1] + index[1]) / 2, (thumb[2] + index[2]) / 2];
        const was = s.pinching;
        // Median of the last 3 ratios: the tracker misplaces the thumb tip for single results.
        s.ratios = [...s.ratios.slice(-2), h.pinch];
        const ratio = [...s.ratios].sort((a, b) => a - b)[Math.floor((s.ratios.length - 1) / 2)] ?? h.pinch;
        const want = h.inFrame && nextPinch(s.pinching, ratio, cfg.pinchOn, cfg.pinchOff);
        if (was && !want) {
            // Release only after the hand has stayed open for PINCH_RELEASE_MS (no drop on a glitch).
            s.releaseSince ??= r.tMs;
            s.pinching = r.tMs - s.releaseSince < PINCH_RELEASE_MS;
        } else {
            s.releaseSince = null;
            s.pinching = want;
        }
        if (!s.pinching) s.releaseSince = null;
        if (s.pinching && !was) {
            s.pinchSince = r.tMs;
            s.frozen = mid;
        }
        const filtered = s.point.filter(mid, r.tMs) as Vec3;
        const point: Vec3 = s.pinching && s.frozen && r.tMs - s.pinchSince < PINCH_FREEZE_MS ? s.frozen : filtered;
        if (!s.pinching) s.frozen = null;
        if (s.cur) s.interval += (Math.min(Math.max(nowMs - s.cur.at, 16), 400) - s.interval) * 0.2;
        // A long gap (hand re-acquired) starts a fresh segment instead of sweeping across the frame.
        s.prev = s.cur && nowMs - s.cur.at < HAND_LOST_MS ? s.cur : null;
        s.cur = { at: nowMs, lm: landmarks, point };
        const bw = bodyWrist(body, h.side);
        const hw = landmarks[PALM.wrist] as Vec3;
        const off: Vec3 | null = bw ? [hw[0] - bw[0], hw[1] - bw[1], hw[2] - bw[2]] : null;
        if (!off || Math.hypot(off[0], off[1], off[2]) > CORR_MAX_M) s.corr = null;
        else s.corr = s.corr ? [s.corr[0] + (off[0] - s.corr[0]) * CORR_ALPHA, s.corr[1] + (off[1] - s.corr[1]) * CORR_ALPHA, s.corr[2] + (off[2] - s.corr[2]) * CORR_ALPHA] : off;
        s.lastSeen = nowMs;
        // Apparent hand size (raw px): max(wrist -> middle MCP, 1.4 x palm width) is steady under
        // pinching (fingers move, the palm does not) and under wrist rotation.
        const px = (i: number, j: number) => {
            const a = h.raw[i];
            const b = h.raw[j];
            return a && b ? Math.hypot((a.x - b.x) * r.rawW, (a.y - b.y) * r.rawH) : 0;
        };
        const size = Math.max(px(PALM.wrist, 9), 1.4 * px(PALM.indexMcp, PALM.pinkyMcp));
        const [sizePx = size] = s.size.filter([size], r.tMs);
        s.out = {
            side: h.side,
            present: true,
            landmarks,
            pinching: s.pinching,
            strength: pinchStrength(h.pinch, cfg.pinchOff),
            point,
            depthM: depthOf(pin, landmarks[PALM.wrist] as Vec3),
            source,
            shape: h.shape,
            sizePx,
        };
    }
}
