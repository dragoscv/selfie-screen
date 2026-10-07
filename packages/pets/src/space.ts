/**
 * Shared 3D space for the studio (pets, AR objects, effects, debug overlay).
 *
 * World frame = the ROOM, in METRES, right-handed, three.js style, gravity-aligned:
 *   floor at y = 0, +Y up, +X to the camera's right, -Z away from the camera.
 *   The camera sits at (0, heightM, 0) and is pitched DOWN by `tiltDeg` (a webcam
 *   on top of a monitor looking at a seated owner). With tilt 0 and height 0 this
 *   is exactly the camera frame.
 *   "Depth" (depthM) is always measured along the camera's optical axis, which is
 *   what perspective size and occlusion depend on.
 * The output image is a pinhole view with vertical field of view `vfovDeg`
 * over the OUTPUT frame (after cover-crop and digital zoom), so pixel <-> ray
 * conversions are exact for the rendered composite.
 *
 * Output-normalised coords (u, v) are [0,1] with v DOWN, like everywhere else
 * in the studio (MediaPipe, Framing).
 */

export interface Pinhole {
    /** Output frame size in px. */
    width: number;
    height: number;
    /** Vertical field of view of the output frame, degrees. */
    vfovDeg: number;
    /** Camera pitch DOWN in degrees (0 = level). */
    tiltDeg?: number;
    /** Camera height above the floor, metres. */
    heightM?: number;
}

export type Vec3 = [number, number, number];

/** Nominal output vFOV; matches the AR layer's NOMINAL_VFOV_DEG. */
export const DEFAULT_VFOV_DEG = 60;

/** Focal length in output px. */
export function focalPx(p: Pinhole): number {
    return p.height / 2 / Math.tan((p.vfovDeg * Math.PI) / 360);
}

/** Camera frame -> room frame (pitch down by tilt, lift by height). */
export function camToWorld(p: Pinhole, c: Vec3): Vec3 {
    const t = ((p.tiltDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    // Rotation about +X by -t (looking down): y' = y cos + z sin, z' = -y sin + z cos.
    return [c[0], c[1] * cos + c[2] * sin + (p.heightM ?? 0), -c[1] * sin + c[2] * cos];
}

/** Room frame -> camera frame. */
export function worldToCam(p: Pinhole, w: Vec3): Vec3 {
    const t = ((p.tiltDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const y = w[1] - (p.heightM ?? 0);
    return [w[0], y * cos - w[2] * sin, y * sin + w[2] * cos];
}

/** Camera-frame DIRECTION -> room-frame direction (tilt only, no height). */
export function camDirToWorld(p: Pinhole, c: Vec3): Vec3 {
    const t = ((p.tiltDeg ?? 0) * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return [c[0], c[1] * cos + c[2] * sin, -c[1] * sin + c[2] * cos];
}

/**
 * Head axes in the upright, display-oriented CAMERA frame (x right, y up, z towards the camera)
 * from a display head pose in degrees (yaw + = towards display-right, pitch + = looking up,
 * roll + = clockwise on screen), i.e. R = Rz(-roll)·Ry(yaw)·Rx(-pitch) applied to +Z and +Y.
 */
export function headAxes(yawDeg: number, pitchDeg: number, rollDeg: number): { forward: Vec3; up: Vec3 } {
    const y = (yawDeg * Math.PI) / 180;
    const x = (-pitchDeg * Math.PI) / 180;
    const z = (-rollDeg * Math.PI) / 180;
    const [cy, sy, cx, sx, cz, sz] = [Math.cos(y), Math.sin(y), Math.cos(x), Math.sin(x), Math.cos(z), Math.sin(z)];
    // Rx: (0,0,1) -> (0, -sx, cx); (0,1,0) -> (0, cx, sx). Then Ry, then Rz.
    const ry = (v: Vec3): Vec3 => [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
    const rz = (v: Vec3): Vec3 => [v[0] * cz - v[1] * sz, v[0] * sz + v[1] * cz, v[2]];
    return { forward: rz(ry([0, -sx, cx])), up: rz(ry([0, cx, sx])) };
}

/** Output-normalised (u, v down) at optical depth `depthM` -> room point. */
export function unproject(p: Pinhole, u: number, v: number, depthM: number): Vec3 {
    const f = focalPx(p);
    const x = ((u - 0.5) * p.width * depthM) / f;
    const y = (-(v - 0.5) * p.height * depthM) / f;
    return camToWorld(p, [x, y, -depthM]);
}

/** Room point -> output-normalised (u, v down) and its optical depth (m, > 0 in front). */
export function project(p: Pinhole, w: Vec3): { u: number; v: number; depthM: number } {
    const c = worldToCam(p, w);
    const d = Math.max(-c[2], 1e-4);
    const f = focalPx(p);
    return { u: 0.5 + (c[0] * f) / (d * p.width), v: 0.5 - (c[1] * f) / (d * p.height), depthM: -c[2] };
}

/** Optical depth (m) of a room point. */
export function depthOf(p: Pinhole, w: Vec3): number {
    return -worldToCam(p, w)[2];
}

/**
 * Camera tilt implied by an upright torso: the neck (shoulder midpoint -> nose)
 * of a seated or standing person is vertical in the room, so its pitch in the
 * camera frame is the camera's tilt. Returns degrees DOWN, or null when the
 * segment is too short / too horizontal to trust.
 */
export function tiltFromUpright(neckBottomCam: Vec3, neckTopCam: Vec3): number | null {
    const dy = neckTopCam[1] - neckBottomCam[1];
    const dz = neckTopCam[2] - neckBottomCam[2];
    if (Math.hypot(dy, dz) < 0.08 || dy <= 0) return null;
    // Upright in the room = (0, 1, 0). In a camera pitched down by t it reads (0, cos t, -sin t)?
    // A room-vertical vector seen by a down-pitched camera leans TOWARDS the camera at the top: dz > 0.
    const t = (Math.atan2(dz, dy) * 180) / Math.PI;
    return t > -30 && t < 60 ? t : null;
}

/** Screen height in px of something `sizeM` tall at `depthM`. */
export function pixelsAt(p: Pinhole, sizeM: number, depthM: number): number {
    return (sizeM * focalPx(p)) / Math.max(depthM, 0.05);
}

/* ------------------------------------------------------------------ *
 * Body model: the owner's skeleton in world metres.
 * ------------------------------------------------------------------ */

/** Joints the pets and the debug overlay use. */
export const BODY_JOINTS = [
    "nose",
    "leftEye",
    "rightEye",
    "leftEar",
    "rightEar",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
    "leftHip",
    "rightHip",
] as const;
export type BodyJoint = (typeof BODY_JOINTS)[number];

/** MediaPipe Pose (33) landmark index per joint. */
export const POSE_INDEX: Readonly<Record<BodyJoint, number>> = {
    nose: 0,
    leftEye: 2,
    rightEye: 5,
    leftEar: 7,
    rightEar: 8,
    leftShoulder: 11,
    rightShoulder: 12,
    leftElbow: 13,
    rightElbow: 14,
    leftWrist: 15,
    rightWrist: 16,
    leftHip: 23,
    rightHip: 24,
};

/** Output-normalised landmark (already rotated/mirrored/cropped), MediaPipe z (hip-relative, ~image-width units). */
export interface OutputLandmark {
    u: number;
    v: number;
    /** MediaPipe relative depth: negative = nearer than the hips, in units of image width. */
    z: number;
    visibility: number;
}

export interface BodyJointState {
    /** World position, metres. */
    p: Vec3;
    /** 0..1: confidence after hysteresis; < 0.5 = treat as unseen (but `p` stays the last good value). */
    conf: number;
    /** ms since this joint was last measured. */
    ageMs: number;
}

/** What every consumer reads, once per render frame. */
export interface BodySnapshot {
    /** Owner present now (tracked recently). */
    present: boolean;
    /** Distance of the torso centre from the camera, metres. */
    distanceM: number;
    joints: Readonly<Record<BodyJoint, BodyJointState>>;
    /**
     * Head centre (between the ears), metres, and its orientation as unit axes in the room frame:
     * `forward` = where the face points (towards the camera = +Z), `up` = top of the head,
     * `right` = the subject's display-right. `rotConf` 0..1 = how much of the orientation comes
     * from the face model (1) vs. the nose/ears guess with a world-up head (0). `euler` = the
     * smoothed display head pose in degrees (yaw + right, pitch + up, roll + clockwise).
     */
    head: { p: Vec3; forward: Vec3; up: Vec3; right: Vec3; conf: number; rotConf: number; euler: { yaw: number; pitch: number; roll: number } };
    /** Top of the head (crown), metres: follows the head's tilt. */
    crown: Vec3;
    /** Shoulder line: left->right unit vector and span in metres. */
    shoulders: { span: number; right: Vec3 };
    /** Upper body facing yaw in radians (0 = facing the camera). */
    yaw: number;
    /** ms since the last pose measurement. */
    poseAgeMs: number;
}

/** Head height crown->chin (m), for the crown estimate. */
export const HEAD_HEIGHT_M = 0.23;
