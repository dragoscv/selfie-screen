import type { VisionCalibration } from "@tiksee/core";

import { countReversals } from "./geometry.js";
import { toScore, type Obs, type Pulse } from "./types.js";

/**
 * Face expressions, winks and head gestures from the 52 MediaPipe blendshapes
 * and the 4x4 facial transformation matrix.
 *
 * Eye sides: `wink_left` is the SUBJECT's left eye. MediaPipe names the
 * blendshapes from the subject's point of view for an unmirrored camera; the
 * calibration wizard confirms it and sets `swapEyes` when it is the other way.
 */

export type Blendshapes = Readonly<Record<string, number>>;

export interface HeadPose {
    /** Degrees, + = subject turns towards display-right. */
    yaw: number;
    /** Degrees, + = looking up. */
    pitch: number;
    /** Degrees, + = head rotated clockwise on the display (tilt_right). */
    roll: number;
}

type M3 = [number, number, number, number, number, number, number, number, number];

/** Row-major 3x3 rotation from a 4x4 column-major matrix (MediaPipe `Matrix.data`). */
export function rotationOf(m: readonly number[]): M3 {
    const e = (r: number, c: number) => m[c * 4 + r] ?? (r === c ? 1 : 0);
    return [e(0, 0), e(0, 1), e(0, 2), e(1, 0), e(1, 1), e(1, 2), e(2, 0), e(2, 1), e(2, 2)];
}

function mul(a: M3, b: M3): M3 {
    const r = new Array<number>(9).fill(0) as M3;
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += (a[i * 3 + k] ?? 0) * (b[k * 3 + j] ?? 0);
            r[i * 3 + j] = s;
        }
    return r;
}

const DEG = 180 / Math.PI;

/**
 * Head pose in DISPLAY terms. The matrix lives in raw camera space (x right,
 * y up, z towards the camera); we turn it upright by the camera `rotation`
 * (clockwise on screen = negative about +z) and mirror it like the preview,
 * then decompose R = Rz(roll)·Ry(yaw)·Rx(pitch).
 */
export function headPose(matrix: readonly number[], rotation: 0 | 90 | 180 | 270 = 0, mirror = false): HeadPose {
    let r = rotationOf(matrix);
    if (rotation !== 0) {
        const a = (-rotation * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        r = mul([c, -s, 0, s, c, 0, 0, 0, 1], r);
    }
    if (mirror) {
        const f: M3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
        r = mul(mul(f, r), f);
    }
    const [r00, , , r10, , , r20, r21, r22] = r;
    const pitchDown = Math.atan2(r21, r22);
    const yaw = Math.atan2(-r20, Math.hypot(r21, r22));
    const rollCcw = Math.atan2(r10, r00);
    return { yaw: yaw * DEG, pitch: -pitchDown * DEG, roll: -rollCcw * DEG };
}

/** Inverse of headPose (rotation 0, no mirror) for tests and synthetic input: 4x4 column-major. */
export function poseMatrix(p: HeadPose): number[] {
    const y = p.yaw / DEG;
    const x = -p.pitch / DEG;
    const z = -p.roll / DEG;
    const rz: M3 = [Math.cos(z), -Math.sin(z), 0, Math.sin(z), Math.cos(z), 0, 0, 0, 1];
    const ry: M3 = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
    const rx: M3 = [1, 0, 0, 0, Math.cos(x), -Math.sin(x), 0, Math.sin(x), Math.cos(x)];
    const r = mul(mul(rz, ry), rx);
    const out = new Array<number>(16).fill(0);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row * 3 + col] ?? 0;
    out[15] = 1;
    return out;
}

export interface FaceOptions {
    winkAsymmetry: number;
    hysteresis: number;
    winkMinMs: number;
    winkMaxMs: number;
    doubleBlinkMs: number;
    eyesClosedMs: number;
    maxYawForWink: number;
    tiltDeg: number;
    lookAwayDeg: number;
    lookAwayMs: number;
    eyeContactDeg: number;
    nodAmplitudeDeg: number;
    shakeAmplitudeDeg: number;
    headGestureWindowMs: number;
    headGestureRefractoryMs: number;
}

export const DEFAULT_FACE: FaceOptions = {
    winkAsymmetry: 0.35,
    hysteresis: 0.15,
    winkMinMs: 120,
    winkMaxMs: 600,
    doubleBlinkMs: 700,
    eyesClosedMs: 600,
    maxYawForWink: 25,
    tiltDeg: 15,
    lookAwayDeg: 30,
    lookAwayMs: 1000,
    eyeContactDeg: 12,
    nodAmplitudeDeg: 6,
    shakeAmplitudeDeg: 8,
    headGestureWindowMs: 1200,
    headGestureRefractoryMs: 1000,
};

type Cal = Pick<VisionCalibration, "blinkLeft" | "blinkRight" | "smile" | "mouthOpen" | "browsUp" | "swapEyes">;

interface Episode {
    start: number;
    /** Which eyes were closed at any point in the episode. */
    left: boolean;
    right: boolean;
    asymmetric: boolean;
    suppressed: boolean;
}

export interface FaceResult {
    obs: Obs[];
    pulses: Pulse[];
    pose: HeadPose;
    /** Eye states after hysteresis, subject sides. */
    leftClosed: boolean;
    rightClosed: boolean;
}

const g = (b: Blendshapes, k: string): number => b[k] ?? 0;

export class FaceAnalyzer {
    readonly #o: FaceOptions;
    #cal: Cal;
    #left = false;
    #right = false;
    #episode: Episode | null = null;
    #lastBlinkEnd = -Infinity;
    #bothClosedSince: number | null = null;
    #awaySince: number | null = null;
    #poses: { t: number; yaw: number; pitch: number }[] = [];
    #lastHeadGesture = -Infinity;

    constructor(calibration: Cal, options: Partial<FaceOptions> = {}) {
        this.#cal = calibration;
        this.#o = { ...DEFAULT_FACE, ...options };
    }

    setCalibration(c: Cal): void {
        this.#cal = c;
    }

    reset(): void {
        this.#left = false;
        this.#right = false;
        this.#episode = null;
        this.#bothClosedSince = null;
        this.#awaySince = null;
        this.#poses = [];
    }

    update(bs: Blendshapes, pose: HeadPose, tMs: number): FaceResult {
        const o = this.#o;
        const c = this.#cal;
        const obs: Obs[] = [];
        const pulses: Pulse[] = [];

        let bl = g(bs, "eyeBlinkLeft");
        let br = g(bs, "eyeBlinkRight");
        if (c.swapEyes) [bl, br] = [br, bl];
        const thrL = c.blinkLeft;
        const thrR = c.blinkRight;
        this.#left = this.#left ? bl > thrL - o.hysteresis : bl > thrL;
        this.#right = this.#right ? br > thrR - o.hysteresis : br > thrR;

        const smile = (g(bs, "mouthSmileLeft") + g(bs, "mouthSmileRight")) / 2;
        const squint = Math.max(g(bs, "cheekSquintLeft"), g(bs, "cheekSquintRight"));
        const suppressed = smile > c.smile || squint > 0.5 || Math.abs(pose.yaw) > o.maxYawForWink;

        // --- blink / wink episodes: from the first closed eye until both are open.
        const anyClosed = this.#left || this.#right;
        if (anyClosed) {
            const e = (this.#episode ??= { start: tMs, left: false, right: false, asymmetric: false, suppressed: false });
            e.left ||= this.#left;
            e.right ||= this.#right;
            if (this.#left !== this.#right && Math.abs(bl - br) > o.winkAsymmetry) e.asymmetric = true;
            e.suppressed ||= suppressed;
        } else if (this.#episode) {
            const e = this.#episode;
            this.#episode = null;
            const dur = tMs - e.start;
            if (e.left && e.right) {
                if (tMs - this.#lastBlinkEnd < o.doubleBlinkMs && dur < o.eyesClosedMs) {
                    pulses.push({ signal: "blink_double", confidence: 0.8 });
                    this.#lastBlinkEnd = -Infinity;
                } else this.#lastBlinkEnd = tMs;
            } else if (e.asymmetric && !e.suppressed && dur >= o.winkMinMs && dur <= o.winkMaxMs) {
                pulses.push({ signal: e.left ? "wink_left" : "wink_right", confidence: 0.85, value: dur });
            }
        }

        if (this.#left && this.#right) {
            this.#bothClosedSince ??= tMs;
            if (tMs - this.#bothClosedSince >= o.eyesClosedMs) obs.push({ signal: "eyes_closed", score: 0.9 });
        } else this.#bothClosedSince = null;

        // --- expressions, against the calibrated thresholds.
        obs.push({ signal: "smile", score: toScore(smile, c.smile), value: smile });
        obs.push({ signal: "mouth_open", score: toScore(g(bs, "jawOpen"), c.mouthOpen) });
        const brows = Math.max(g(bs, "browInnerUp"), (g(bs, "browOuterUpLeft") + g(bs, "browOuterUpRight")) / 2);
        obs.push({ signal: "brows_up", score: toScore(brows, c.browsUp) });
        obs.push({ signal: "pucker", score: toScore(g(bs, "mouthPucker"), 0.5) });
        obs.push({ signal: "tongue_out", score: toScore(g(bs, "tongueOut"), 0.4) });
        obs.push({ signal: "cheek_puff", score: toScore(g(bs, "cheekPuff"), 0.4) });

        // --- head pose.
        const tiltScore = 0.5 + Math.min(0.5, (Math.abs(pose.roll) - o.tiltDeg) / 30);
        if (pose.roll > o.tiltDeg) obs.push({ signal: "tilt_right", score: tiltScore, value: pose.roll });
        if (pose.roll < -o.tiltDeg) obs.push({ signal: "tilt_left", score: tiltScore, value: pose.roll });
        const away = Math.abs(pose.yaw) > o.lookAwayDeg || Math.abs(pose.pitch) > o.lookAwayDeg;
        if (away) {
            this.#awaySince ??= tMs;
            if (tMs - this.#awaySince >= o.lookAwayMs) obs.push({ signal: "look_away", score: 0.85 });
        } else this.#awaySince = null;
        const gaze = Math.max(
            g(bs, "eyeLookOutLeft"),
            g(bs, "eyeLookOutRight"),
            g(bs, "eyeLookInLeft"),
            g(bs, "eyeLookInRight"),
            g(bs, "eyeLookUpLeft"),
            g(bs, "eyeLookDownLeft"),
        );
        if (Math.abs(pose.yaw) < o.eyeContactDeg && Math.abs(pose.pitch) < o.eyeContactDeg && !anyClosed && gaze < 0.45) {
            obs.push({ signal: "eye_contact", score: 0.8 });
        }

        // --- nod / shake: oscillation of pitch / yaw over the window.
        this.#poses.push({ t: tMs, yaw: pose.yaw, pitch: pose.pitch });
        while (this.#poses.length > 0 && tMs - (this.#poses[0]?.t ?? tMs) > o.headGestureWindowMs) this.#poses.shift();
        if (tMs - this.#lastHeadGesture >= o.headGestureRefractoryMs && this.#poses.length >= 6) {
            const pitches = this.#poses.map((p) => p.pitch);
            const yaws = this.#poses.map((p) => p.yaw);
            const range = (v: number[]) => Math.max(...v) - Math.min(...v);
            const nod = countReversals(pitches, o.nodAmplitudeDeg) >= 2 && range(yaws) < range(pitches) * 0.6;
            const shake = countReversals(yaws, o.shakeAmplitudeDeg) >= 2 && range(pitches) < range(yaws) * 0.6;
            if (nod || shake) {
                pulses.push({ signal: nod ? "nod" : "shake", confidence: 0.8 });
                this.#lastHeadGesture = tMs;
                this.#poses = [];
            }
        }

        return { obs, pulses, pose, leftClosed: this.#left, rightClosed: this.#right };
    }
}
