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
 *     (on < pinchOn, off > pinchOff, in palm widths) and a 50 ms freeze of the
 *     pinch point at onset (closing the fingers moves the midpoint).
 * Output feeds PetStage.setHands (grab / resize) and the F3 overlay.
 */

const HAND_FILTER = { minCutoff: 1.6, beta: 0.6, dCutoff: 1 };
const POINT_FILTER = { minCutoff: 1.2, beta: 0.9, dCutoff: 1 };
/** A solve this far (m) from the pose wrist depth is rejected. */
export const WRIST_GATE_M = 0.25;
/** Hand unseen this long = not present. */
export const HAND_LOST_MS = 150;
/** Pinch point frozen this long at pinch onset. */
export const PINCH_FREEZE_MS = 50;
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
}

/** Pinch strength 0..1 from the thumb-index / palm ratio (1 = touching). */
export function pinchStrength(ratio: number, pinchOff: number): number {
    const lo = 0.05;
    return Math.min(1, Math.max(0, 1 - (ratio - lo) / Math.max(pinchOff - lo, 1e-3)));
}

/** Pinch hysteresis: enter below `on`, leave above `off`. */
export function nextPinch(pinching: boolean, ratio: number, on: number, off: number): boolean {
    return pinching ? ratio < off : ratio < on;
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
                if (nowMs - s.lastSeen > 400) {
                    s.lm.reset();
                    s.point.reset();
                }
            }
            s.out = { ...s.out, present, pinching: present && s.pinching };
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
        s.pinching = h.inFrame && nextPinch(s.pinching, h.pinch, cfg.pinchOn, cfg.pinchOff);
        if (s.pinching && !was) {
            s.pinchSince = r.tMs;
            s.frozen = mid;
        }
        const filtered = s.point.filter(mid, r.tMs) as Vec3;
        const point: Vec3 = s.pinching && s.frozen && r.tMs - s.pinchSince < PINCH_FREEZE_MS ? s.frozen : filtered;
        if (!s.pinching) s.frozen = null;
        s.lastSeen = nowMs;
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
        };
    }
}
