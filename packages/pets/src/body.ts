import { SHOULDER_WIDTH_M } from "./catalogue.js";
import { OneEuroPoint, type OneEuroOptions } from "./one-euro.js";
import {
    BODY_JOINTS,
    HEAD_HEIGHT_M,
    POSE_INDEX,
    camToWorld,
    tiltFromUpright,
    unproject,
    type BodyJoint,
    type BodyJointState,
    type BodySnapshot,
    type OutputLandmark,
    type Pinhole,
    type Vec3,
} from "./space.js";

/**
 * The owner's skeleton in world metres, sampled every RENDER frame from pose
 * measurements that arrive at 10-30 Hz.
 *
 * Smoothness (owner: "the skeleton is jumpy"):
 *  - Each measurement is filtered in IMAGE space (px, One-Euro) and in depth
 *    separately, then unprojected ONCE. Filtering metres and rescaling by the
 *    raw depth leaked depth noise into x/y (~50 px at a wrist near the edge).
 *  - Samples are kept per joint with their CAPTURE time. The render shows the
 *    body `delayMs` in the past and interpolates between real samples with a
 *    cubic Hermite (Catmull-Rom tangents): continuous position AND velocity,
 *    no overshoot from guessing ahead. The delay adapts to the measured
 *    arrival latency + interval (p90), clamped 50-160 ms. When samples run out
 *    it extrapolates at most one interval, then holds.
 *  - Each joint has its own confidence with hysteresis (on above 0.6, off below
 *    0.35) and keeps its last good position when unseen. Nothing toggles per
 *    frame; consumers fade on `conf`.
 *  - Depth: x/y come from the 2D landmark unprojected at the joint's own depth;
 *    depth = torso distance (body-scale / depth model) + MediaPipe's relative z
 *    (hip-relative, in image-width units, scaled to metres by the shoulder span).
 */

/**
 * One-Euro on image px (output frame). With MediaPipe's own smoothing on
 * (numPoses 1) this only removes residual jitter: 1.2 Hz at rest, cutoff
 * rising ~3.5 Hz per 500 px/s of motion.
 */
export const JOINT_FILTER: OneEuroOptions = { minCutoff: 1.2, beta: 0.007, dCutoff: 1 };
/** Depth (m) is the noisiest axis: strong low-pass, speed-adaptive. */
export const DEPTH_FILTER: OneEuroOptions = { minCutoff: 0.3, beta: 0.3, dCutoff: 1 };
/** Interpolation delay bounds (ms). */
export const MIN_DELAY_MS = 50;
export const MAX_DELAY_MS = 160;
/** Samples kept per joint. */
const RING = 8;
/** A joint unseen for this long is gone (conf decays to 0 over FADE_MS after it). */
export const LOST_AFTER_MS = 600;
export const FADE_MS = 400;
export const CONF_ON = 0.6;
export const CONF_OFF = 0.35;
/** Owner absent for this long = not present. */
export const ABSENT_AFTER_MS = 1500;

interface Sample {
    t: number;
    p: Vec3;
}

interface JointTrack {
    /** Measurement filters: image px and depth separately. */
    fxy: OneEuroPoint;
    fz: OneEuroPoint;
    /** Filtered samples (room metres) by capture time, oldest first. */
    ring: Sample[];
    /** Rendered position. */
    p: Vec3;
    on: boolean;
    conf: number;
    seenAt: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
    const l = len(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

function newTrack(): JointTrack {
    return {
        fxy: new OneEuroPoint(2, JOINT_FILTER),
        fz: new OneEuroPoint(1, DEPTH_FILTER),
        ring: [],
        p: [0, 0, -1],
        on: false,
        conf: 0,
        seenAt: -Infinity,
    };
}

/** Cubic Hermite between p1 (t1) and p2 (t2) with Catmull-Rom tangents from p0 and p3. */
export function hermite(p0: Sample, p1: Sample, p2: Sample, p3: Sample, t: number): Vec3 {
    const dt = Math.max(p2.t - p1.t, 1e-3);
    const s = Math.min(Math.max((t - p1.t) / dt, 0), 1);
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        // Tangents in units per ms, scaled to the segment length.
        const m1 = ((p2.p[i] ?? 0) - (p0.p[i] ?? 0)) / Math.max(p2.t - p0.t, 1e-3);
        const m2 = ((p3.p[i] ?? 0) - (p1.p[i] ?? 0)) / Math.max(p3.t - p1.t, 1e-3);
        out[i] = h00 * (p1.p[i] ?? 0) + h10 * dt * m1 + h01 * (p2.p[i] ?? 0) + h11 * dt * m2;
    }
    return out;
}

/** Position of a joint at render time `t` from its sample ring. */
export function sampleRing(ring: readonly Sample[], t: number): Vec3 | null {
    const n = ring.length;
    if (n === 0) return null;
    const last = ring[n - 1] as Sample;
    if (n === 1 || t <= (ring[0] as Sample).t) return t <= (ring[0] as Sample).t ? (ring[0] as Sample).p : last.p;
    if (t >= last.t) {
        // Past the newest sample: extrapolate at most one interval at half velocity, then hold.
        const prev = ring[n - 2] as Sample;
        const span = Math.max(last.t - prev.t, 1);
        const ahead = Math.min(t - last.t, span);
        const k = (0.5 * ahead) / span;
        return [last.p[0] + (last.p[0] - prev.p[0]) * k, last.p[1] + (last.p[1] - prev.p[1]) * k, last.p[2] + (last.p[2] - prev.p[2]) * k];
    }
    let i = 0;
    while (i < n - 2 && (ring[i + 1] as Sample).t <= t) i++;
    const p1 = ring[i] as Sample;
    const p2 = ring[i + 1] as Sample;
    const p0 = ring[i - 1] ?? p1;
    const p3 = ring[i + 2] ?? p2;
    return hermite(p0, p1, p2, p3, t);
}

export interface BodyMeasurement {
    /** Capture time of the camera frame (performance clock, ms). */
    tMs: number;
    /** Output-normalised landmarks (33, MediaPipe order), or null when nobody was seen. */
    landmarks: readonly OutputLandmark[] | null;
    /** Torso distance from the camera (m), from body scale / depth model; undefined = keep the last. */
    distanceM: number | undefined;
    /**
     * Optional metric depth (m, along the optical axis) per MediaPipe pose index, from the
     * whole-body solve of the world landmarks. Preferred over MediaPipe's image `z`, which
     * is far too weak for arms reaching towards the camera.
     */
    jointDepthM?: readonly (number | undefined)[];
}

export class BodyModel {
    readonly #tracks = new Map<BodyJoint, JointTrack>(BODY_JOINTS.map((j) => [j, newTrack()]));
    #pin: Pinhole;
    #distance = 1;
    #lastPoseAt = -Infinity;
    #snapshot: BodySnapshot | null = null;
    /** Camera tilt (deg down) estimated from the upright neck; null until enough samples. */
    #tiltEst: number | null = null;
    /** Recent (arrival - capture) + interval, ms, for the adaptive delay. */
    readonly #lags: number[] = [];
    #lastCapture = -Infinity;
    #delay = 90;

    constructor(pinhole: Pinhole, initialDistanceM = 1) {
        this.#pin = pinhole;
        this.#distance = initialDistanceM;
    }

    set pinhole(p: Pinhole) {
        this.#pin = p;
    }

    get pinhole(): Pinhole {
        return this.#pin;
    }

    /** Tilt estimated from an upright neck (shoulders -> ears), degrees down, or null. */
    get estimatedTiltDeg(): number | null {
        return this.#tiltEst;
    }

    /** Current interpolation delay (ms) behind real time. */
    get delayMs(): number {
        return this.#delay;
    }

    /**
     * Feed one pose result. `m.tMs` = capture time; `arrivalMs` = when it reached us
     * (performance clock), used to size the interpolation delay.
     */
    measure(m: BodyMeasurement, arrivalMs = m.tMs): void {
        if (m.distanceM !== undefined && Number.isFinite(m.distanceM) && m.distanceM > 0.2) {
            // Distance itself is noisy: low-pass it (~0.3 s).
            this.#distance += (m.distanceM - this.#distance) * 0.25;
        }
        const lm = m.landmarks;
        if (!lm) return;
        if (m.tMs <= this.#lastCapture) return; // stale / duplicate frame
        const interval = Number.isFinite(this.#lastCapture) ? m.tMs - this.#lastCapture : 33;
        this.#lastCapture = m.tMs;
        this.#lags.push(Math.max(0, arrivalMs - m.tMs) + Math.min(interval, 200));
        if (this.#lags.length > 40) this.#lags.shift();
        const sorted = [...this.#lags].sort((a, b) => a - b);
        const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 90;
        const want = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, p90 + 8));
        // Move the delay slowly (no time-warp jumps).
        this.#delay += (want - this.#delay) * 0.1;
        this.#lastPoseAt = m.tMs;
        // MediaPipe z is in image-WIDTH units relative to the hips. Convert to metres using
        // the shoulder span measured in the same units (shoulder width = 0.4 m).
        const ls = lm[POSE_INDEX.leftShoulder];
        const rs = lm[POSE_INDEX.rightShoulder];
        const aspect = this.#pin.width / Math.max(this.#pin.height, 1);
        const spanW = ls && rs ? Math.hypot(ls.u - rs.u, (ls.v - rs.v) / aspect) : 0;
        const mPerZ = spanW > 0.02 ? SHOULDER_WIDTH_M / spanW : 0;
        // Torso reference z: the shoulders' mean z (hips are often out of frame).
        const refZ = ls && rs ? (ls.z + rs.z) / 2 : 0;
        // Camera-frame pinhole (no tilt/height): filtering happens there.
        const camPin: Pinhole = { width: this.#pin.width, height: this.#pin.height, vfovDeg: this.#pin.vfovDeg };
        const W = this.#pin.width;
        const H = this.#pin.height;
        const camPts: Partial<Record<BodyJoint, Vec3>> = {};
        for (const joint of BODY_JOINTS) {
            const l = lm[POSE_INDEX[joint]];
            if (!l) continue;
            const t = this.#tracks.get(joint);
            if (!t) continue;
            const vis = l.visibility;
            // A landmark far off-frame is extrapolated by MediaPipe and unreliable.
            const inFrame = l.u > -0.15 && l.u < 1.15 && l.v > -0.15 && l.v < 1.15;
            if (vis < CONF_OFF || !inFrame) continue;
            const solved = m.jointDepthM?.[POSE_INDEX[joint]];
            const depth = Math.max(0.2, solved !== undefined && Number.isFinite(solved) ? solved : this.#distance + (mPerZ ? (l.z - refZ) * mPerZ : 0));
            // Filter where the noise lives: image px for x/y, metres for depth. Unproject once.
            const [px = l.u * W, py = l.v * H] = t.fxy.filter([l.u * W, l.v * H], m.tMs);
            const [fd = depth] = t.fz.filter([depth], m.tMs);
            const cam = unproject(camPin, px / W, py / H, fd);
            camPts[joint] = cam;
            const p = camToWorld(this.#pin, cam);
            t.ring.push({ t: m.tMs, p });
            if (t.ring.length > RING) t.ring.shift();
            t.seenAt = m.tMs;
            if (vis >= CONF_ON) t.on = true;
            if (t.ring.length === 1) t.p = p;
        }
        this.#estimateTilt(camPts);
    }

    #estimateTilt(c: Partial<Record<BodyJoint, Vec3>>): void {
        const ls = c.leftShoulder;
        const rs = c.rightShoulder;
        const le = c.leftEar;
        const re = c.rightEar;
        if (!ls || !rs || !le || !re) return;
        const bottom: Vec3 = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2];
        const top: Vec3 = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2, (le[2] + re[2]) / 2];
        const t = tiltFromUpright(bottom, top);
        if (t === null) return;
        this.#tiltEst = this.#tiltEst === null ? t : this.#tiltEst + (t - this.#tiltEst) * 0.02;
    }

    /** Drop filter state (camera pose or framing changed abruptly). */
    resetFilters(): void {
        for (const t of this.#tracks.values()) {
            t.fxy.reset();
            t.fz.reset();
            t.ring = [];
        }
        this.#lastCapture = -Infinity;
    }

    /** Interpolate every joint at `nowMs - delayMs` and return the snapshot. Call once per render frame. */
    sample(nowMs: number, dtSec: number): BodySnapshot {
        const at = nowMs - this.#delay;
        const joints = {} as Record<BodyJoint, BodyJointState>;
        for (const joint of BODY_JOINTS) {
            const t = this.#tracks.get(joint) as JointTrack;
            const age = nowMs - t.seenAt;
            const p = sampleRing(t.ring, at);
            if (p) t.p = p;
            // Confidence: hysteresis on measurement presence, then a linear fade.
            if (age > LOST_AFTER_MS) t.on = false;
            const want = t.on ? 1 : 0;
            const step = dtSec * 1000 / FADE_MS;
            // Fade in twice as fast as out; hold exactly at the target (no oscillation).
            if (want > t.conf) t.conf = Math.min(want, t.conf + step * 2);
            else if (want < t.conf) t.conf = Math.max(want, t.conf - step);
            joints[joint] = { p: t.p, conf: t.conf, ageMs: Number.isFinite(age) ? age : 1e9 };
        }
        this.#snapshot = this.#derive(joints, nowMs);
        return this.#snapshot;
    }

    get snapshot(): BodySnapshot | null {
        return this.#snapshot;
    }

    #derive(j: Record<BodyJoint, BodyJointState>, nowMs: number): BodySnapshot {
        const pin = this.#pin;
        const ls = j.leftShoulder;
        const rs = j.rightShoulder;
        const haveShoulders = ls.conf > 0.05 && rs.conf > 0.05;
        // Shoulder line. MediaPipe "left" = subject's left = image right when mirrored; use geometry.
        let right: Vec3 = [1, 0, 0];
        let span = SHOULDER_WIDTH_M;
        if (haveShoulders) {
            const d = sub(ls.p, rs.p);
            span = Math.max(len(d), 0.1);
            right = norm(d[0] >= 0 ? d : scale(d, -1));
        }
        // Head centre: ears > eyes > nose, offset back from the nose.
        const earsOk = j.leftEar.conf > 0.3 && j.rightEar.conf > 0.3;
        const eyesOk = j.leftEye.conf > 0.3 && j.rightEye.conf > 0.3;
        let headP: Vec3;
        let headConf: number;
        if (earsOk) {
            headP = mid(j.leftEar.p, j.rightEar.p);
            headConf = Math.min(j.leftEar.conf, j.rightEar.conf);
        } else if (eyesOk) {
            headP = add(mid(j.leftEye.p, j.rightEye.p), [0, -0.02, -0.06]);
            headConf = Math.min(j.leftEye.conf, j.rightEye.conf);
        } else if (j.nose.conf > 0.3) {
            headP = add(j.nose.p, [0, 0.02, -0.08]);
            headConf = j.nose.conf;
        } else if (haveShoulders) {
            // Unseen head: above the shoulder midpoint.
            headP = add(mid(ls.p, rs.p), [0, 0.25, 0]);
            headConf = 0;
        } else {
            headP = unproject(pin, 0.5, 0.3, this.#distance);
            headConf = 0;
        }
        // Face direction from nose relative to the head centre (towards the camera = +Z).
        let forward: Vec3 = [0, 0, 1];
        if (j.nose.conf > 0.3 && (earsOk || eyesOk)) {
            const f = sub(j.nose.p, headP);
            forward = norm([f[0], f[1] * 0.5, Math.max(f[2], 0.02) + 0.05]);
        }
        const crown = add(headP, [0, HEAD_HEIGHT_M * 0.55, 0]);
        // Yaw from the shoulder depth difference.
        const yaw = haveShoulders ? Math.atan2(ls.p[2] - rs.p[2], Math.abs(ls.p[0] - rs.p[0]) || 1e-3) : 0;
        const present = nowMs - this.#lastPoseAt < ABSENT_AFTER_MS;
        return {
            present,
            distanceM: this.#distance,
            joints: j,
            head: { p: headP, forward, conf: headConf },
            crown,
            shoulders: { span, right },
            yaw,
            poseAgeMs: Number.isFinite(this.#lastPoseAt) ? nowMs - this.#lastPoseAt : 1e9,
        };
    }
}
