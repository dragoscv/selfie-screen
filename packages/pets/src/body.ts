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
 * Why this exists (the old pets flickered and stepped):
 *  - Measurements are timestamped and the render samples a short-latency
 *    critically-damped spring toward a velocity-extrapolated target, so motion
 *    is continuous at any render rate instead of jumping when a pose lands.
 *  - Each joint has its own confidence with hysteresis (on above 0.6, off below
 *    0.35) and keeps its last good position when unseen. Nothing toggles per
 *    frame; consumers fade on `conf`.
 *  - Depth: x/y come from the 2D landmark unprojected at the joint's own depth;
 *    depth = torso distance (body-scale / depth model) + MediaPipe's relative z
 *    (hip-relative, in image-width units, scaled to metres by the shoulder span).
 */

/** Seconds; time constant of the render-rate follow spring. */
export const FOLLOW_TAU_S = 0.12;
/** Extrapolate at most this far past the newest measurement, at half the measured velocity. */
export const MAX_EXTRAPOLATE_MS = 60;
/**
 * One-Euro on each MEASURED joint (in metres): MediaPipe landmarks jitter by a few
 * pixels (= 1-2 cm at 1 m) and depth by several cm per frame. minCutoff 0.8 Hz keeps
 * a still body still; beta 1.5 (per m/s) lets real motion through with little lag.
 */
export const JOINT_FILTER: OneEuroOptions = { minCutoff: 0.8, beta: 1.5, dCutoff: 1 };
/** Depth gets a stronger filter: it is the noisiest axis. */
export const DEPTH_FILTER: OneEuroOptions = { minCutoff: 0.4, beta: 0.6, dCutoff: 1 };
/** A joint unseen for this long is gone (conf decays to 0 over FADE_MS after it). */
export const LOST_AFTER_MS = 600;
export const FADE_MS = 400;
export const CONF_ON = 0.6;
export const CONF_OFF = 0.35;
/** Owner absent for this long = not present. */
export const ABSENT_AFTER_MS = 1500;

interface JointTrack {
    /** Measurement filters: x/y (metres) and depth separately. */
    fxy: OneEuroPoint;
    fz: OneEuroPoint;
    /** Two latest measurements for velocity. */
    a: Vec3 | null;
    ta: number;
    b: Vec3 | null;
    tb: number;
    /** Rendered (smoothed) position and velocity. */
    p: Vec3;
    v: Vec3;
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
        a: null,
        ta: 0,
        b: null,
        tb: 0,
        p: [0, 0, -1],
        v: [0, 0, 0],
        on: false,
        conf: 0,
        seenAt: -Infinity,
    };
}

export interface BodyMeasurement {
    /** Capture time of the camera frame (performance clock, ms). */
    tMs: number;
    /** Output-normalised landmarks (33, MediaPipe order), or null when nobody was seen. */
    landmarks: readonly OutputLandmark[] | null;
    /** Torso distance from the camera (m), from body scale / depth model; undefined = keep the last. */
    distanceM: number | undefined;
}

export class BodyModel {
    readonly #tracks = new Map<BodyJoint, JointTrack>(BODY_JOINTS.map((j) => [j, newTrack()]));
    #pin: Pinhole;
    #distance = 1;
    #lastPoseAt = -Infinity;
    #snapshot: BodySnapshot | null = null;
    /** Camera tilt (deg down) estimated from the upright neck; null until enough samples. */
    #tiltEst: number | null = null;

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

    /** Feed one pose result. Cheap; call when a new vision frame lands. */
    measure(m: BodyMeasurement): void {
        if (m.distanceM !== undefined && Number.isFinite(m.distanceM) && m.distanceM > 0.2) {
            // Distance itself is noisy: low-pass it (~0.3 s).
            this.#distance += (m.distanceM - this.#distance) * 0.25;
        }
        const lm = m.landmarks;
        if (!lm) return;
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
        // Camera-frame copy (no tilt/height) for the auto-tilt estimate.
        const camPin: Pinhole = { width: this.#pin.width, height: this.#pin.height, vfovDeg: this.#pin.vfovDeg };
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
            const depth = Math.max(0.3, this.#distance + (mPerZ ? (l.z - refZ) * mPerZ : 0));
            // Filter in the camera frame (image-plane metres + depth), then go to the room.
            const raw = unproject(camPin, l.u, l.v, depth);
            const [fx = raw[0], fy = raw[1]] = t.fxy.filter([raw[0], raw[1]], m.tMs);
            const [fd = depth] = t.fz.filter([depth], m.tMs);
            // Re-project the filtered x/y to the filtered depth along the same ray.
            const k = fd / depth;
            const cam: Vec3 = [fx * k, fy * k, -fd];
            camPts[joint] = cam;
            const p = camToWorld(this.#pin, cam);
            t.a = t.b;
            t.ta = t.tb;
            t.b = p;
            t.tb = m.tMs;
            t.seenAt = m.tMs;
            if (vis >= CONF_ON) t.on = true;
            if (!t.on && t.a === null) {
                // First sight below CONF_ON: start the spring at the point so it doesn't fly in.
                t.p = p;
            }
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
            t.a = null;
            t.b = null;
        }
    }

    /** Advance the render-rate spring to `nowMs` and return the snapshot. Call once per render frame. */
    sample(nowMs: number, dtSec: number): BodySnapshot {
        const k = 1 - Math.exp(-Math.max(dtSec, 0) / FOLLOW_TAU_S);
        const joints = {} as Record<BodyJoint, BodyJointState>;
        for (const joint of BODY_JOINTS) {
            const t = this.#tracks.get(joint) as JointTrack;
            const age = nowMs - t.seenAt;
            if (t.b) {
                let target = t.b;
                if (t.a && t.tb > t.ta) {
                    const v = scale(sub(t.b, t.a), 1 / (t.tb - t.ta));
                    const ahead = Math.min(Math.max(nowMs - t.tb, 0), MAX_EXTRAPOLATE_MS);
                    // Half velocity: full extrapolation overshoots on every direction change.
                    target = add(t.b, scale(v, ahead * 0.5));
                }
                if (t.conf === 0 && t.on) t.p = target;
                const np = add(t.p, scale(sub(target, t.p), k));
                t.v = dtSec > 0 ? scale(sub(np, t.p), 1 / dtSec) : t.v;
                t.p = np;
            }
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
