import type { Vec3 } from "./space.js";

/**
 * Metric distance of the owner from ONE monocular camera, robust to turning,
 * arm poses and partial visibility (owner: pets "grow and shrink wrongly").
 *
 * Sources, fused by `DistanceFilter` (constant-velocity Kalman on log Z):
 *  1. Whole-body solve: MediaPipe `worldLandmarks` are metric (hip-centred) and
 *     consistent with the image landmarks. With the body roughly camera-aligned
 *     (rotation folded into the world points), each visible joint gives two
 *     linear equations in the root translation t = (tx, ty, tz):
 *        x_i (Z_i + tz) = f (X_i + tx)      x_i = (u_i - cx) in px
 *        y_i (Z_i + tz) = f (Y_i + ty)      y_i = (v_i - cy) in px, y down
 *     solved by weighted least squares over ~15 joints. A shoulder pair alone
 *     shrinks with cos(yaw) and arm pose; this does not.
 *  2. Iris: the human iris is 11.7 ± 0.5 mm across (MediaPipe Iris, 4.3 % mean
 *     error). Z = f * 11.7 mm / iris_px. Only trusted when the iris is ≥ ~14 px.
 *  3. Personal scale: after calibration, the owner's own shoulder width / iris
 *     replace the population averages.
 * Everything here works in RAW CAMERA pixels (full sensor frame, before crop /
 * zoom), with the camera focal length `fPx` for that frame.
 */

export interface CameraIntrinsics {
    /** Focal length in raw camera pixels. */
    fPx: number;
    /** Principal point, raw px. */
    cx: number;
    cy: number;
}

/** Focal length in px from a vertical FOV over an image `h` px tall. */
export function focalFromVfov(vfovDeg: number, h: number): number {
    return h / 2 / Math.tan((vfovDeg * Math.PI) / 360);
}

export function vfovFromFocal(fPx: number, h: number): number {
    return (2 * Math.atan(h / 2 / fPx) * 180) / Math.PI;
}

/**
 * Vertical FOV of a lens on a sensor (16:9 crop of the sensor height for video).
 * Sony APS-C (ZV-E10) 1080p uses ~23.5 × 13.2 mm.
 */
export function lensVfov(focalMm: number, sensorHeightMm: number): number {
    return (2 * Math.atan(sensorHeightMm / 2 / Math.max(focalMm, 1)) * 180) / Math.PI;
}

/** Known cameras: vertical FOV of a 16:9 1080p frame (manufacturer data or lens formula). */
export const CAMERA_PRESETS = {
    /** Sony ZV-E10, APS-C video crop 13.2 mm high; focal length from the lens. */
    "sony-zv-e10": { label: "Sony ZV-E10 (APS-C, set the lens mm)", sensorHeightMm: 13.2, defaultFocalMm: 16 },
    /** Logitech C920 / C922: 78° diagonal. */
    "logitech-c920": { label: "Logitech C920 / C922", vfovDeg: 43.3 },
    /** Logitech Brio 4K at its 90° diagonal setting. */
    "logitech-brio-90": { label: "Logitech Brio (90°)", vfovDeg: 52.0 },
    "logitech-brio-78": { label: "Logitech Brio (78°)", vfovDeg: 43.3 },
    "logitech-brio-65": { label: "Logitech Brio (65°)", vfovDeg: 35.6 },
    /** Typical laptop webcam ~ 70-78° diagonal. */
    laptop: { label: "Laptop webcam", vfovDeg: 41.0 },
    custom: { label: "Custom / calibrated", vfovDeg: 45.0 },
} as const;
export type CameraPreset = keyof typeof CAMERA_PRESETS;

/** Diagonal FOV -> vertical FOV for a 16:9 frame. */
export function diagonalToVfov(diagDeg: number, aspect = 16 / 9): number {
    const d = Math.tan((diagDeg * Math.PI) / 360);
    const v = d / Math.hypot(aspect, 1);
    return (2 * Math.atan(v) * 180) / Math.PI;
}

/** One joint for the body solve: image point (raw px) and its metric hip-centred world point. */
export interface SolveJoint {
    u: number;
    v: number;
    /** MediaPipe worldLandmark: metres, hip-centred, +x subject-left?, +y DOWN, +z away from camera. */
    world: Vec3;
    weight: number;
}

/**
 * Root translation (camera frame, metres; +x right, +y DOWN, +z forward = depth)
 * from image + metric world landmarks. Returns null when fewer than 4 joints or
 * the system is degenerate. `residualPx` = RMS reprojection error.
 */
export function solveRootTranslation(joints: readonly SolveJoint[], k: CameraIntrinsics): { t: Vec3; residualPx: number } | null {
    const use = joints.filter((j) => j.weight > 0.2);
    if (use.length < 4) return null;
    // Normal equations for A t = b, unknowns (tx, ty, tz).
    // x row: f*tx - x*tz = x*Z - f*X ; y row: f*ty - y*tz = y*Z - f*Y
    const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const atb = [0, 0, 0];
    const addRow = (a0: number, a1: number, a2: number, b: number, w: number) => {
        const r = [a0, a1, a2];
        for (let i = 0; i < 3; i++) {
            atb[i] = (atb[i] ?? 0) + w * (r[i] ?? 0) * b;
            for (let j = 0; j < 3; j++) ata[i * 3 + j] = (ata[i * 3 + j] ?? 0) + w * (r[i] ?? 0) * (r[j] ?? 0);
        }
    };
    for (const j of use) {
        const x = j.u - k.cx;
        const y = j.v - k.cy;
        const [X, Y, Z] = j.world;
        addRow(k.fPx, 0, -x, x * Z - k.fPx * X, j.weight);
        addRow(0, k.fPx, -y, y * Z - k.fPx * Y, j.weight);
    }
    const t = solve3(ata, atb);
    if (!t || !(t[2] > 0.2) || t[2] > 8) return null;
    let err = 0;
    let n = 0;
    for (const j of use) {
        const Z = j.world[2] + t[2];
        if (Z <= 0.05) continue;
        const pu = k.cx + (k.fPx * (j.world[0] + t[0])) / Z;
        const pv = k.cy + (k.fPx * (j.world[1] + t[1])) / Z;
        err += (pu - j.u) ** 2 + (pv - j.v) ** 2;
        n++;
    }
    return { t, residualPx: n ? Math.sqrt(err / n) : Infinity };
}

/** 3×3 solve (Cramer). */
function solve3(a: number[], b: number[]): Vec3 | null {
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0, a8 = 0] = a;
    const det = a0 * (a4 * a8 - a5 * a7) - a1 * (a3 * a8 - a5 * a6) + a2 * (a3 * a7 - a4 * a6);
    if (Math.abs(det) < 1e-9) return null;
    const [b0 = 0, b1 = 0, b2 = 0] = b;
    const dx = b0 * (a4 * a8 - a5 * a7) - a1 * (b1 * a8 - a5 * b2) + a2 * (b1 * a7 - a4 * b2);
    const dy = a0 * (b1 * a8 - a5 * b2) - b0 * (a3 * a8 - a5 * a6) + a2 * (a3 * b2 - b1 * a6);
    const dz = a0 * (a4 * b2 - b1 * a7) - a1 * (a3 * b2 - b1 * a6) + b0 * (a3 * a7 - a4 * a6);
    return [dx / det, dy / det, dz / det];
}

/** Human iris diameter (m), population mean (MediaPipe Iris). */
export const IRIS_DIAMETER_M = 0.0117;
/** Below this iris size (px) one pixel of noise is > 7 % of the distance: not trusted. */
export const MIN_IRIS_PX = 14;

/** Camera distance of the eyes from the iris diameter in raw px. */
export function irisDistance(irisPx: number, fPx: number, irisM = IRIS_DIAMETER_M): number | null {
    if (!(irisPx >= MIN_IRIS_PX)) return null;
    return (fPx * irisM) / irisPx;
}

/** Measurement for the distance filter: distance (m) and its 1-sigma relative error. */
export interface DistanceObservation {
    distanceM: number;
    /** Relative sigma (0.05 = 5 %). */
    relSigma: number;
    source: "body" | "iris" | "shoulders";
}

/**
 * Constant-velocity Kalman filter on log(distance), so a 5 % error weighs the
 * same at 0.6 m and 2 m. Innovations beyond 3 sigma are rejected (a wrong
 * person, a hand in front of the face) unless they persist (re-acquire).
 */
export class DistanceFilter {
    #x = Math.log(1);
    #v = 0;
    #p00 = 1;
    #p01 = 0;
    #p11 = 1;
    #t: number | null = null;
    #rejected = 0;
    /** Process noise: log-distance acceleration (1/s²), ~ a person leaning quickly. */
    readonly #q: number;

    constructor(initialM = 1, q = 0.6) {
        this.#x = Math.log(initialM);
        this.#q = q;
    }

    get distanceM(): number {
        return Math.exp(this.#x);
    }

    /** 1-sigma relative uncertainty of the current estimate. */
    get relSigma(): number {
        return Math.sqrt(Math.max(this.#p00, 0));
    }

    predict(tMs: number): void {
        if (this.#t === null) {
            this.#t = tMs;
            return;
        }
        const dt = Math.min(Math.max((tMs - this.#t) / 1000, 0), 0.5);
        this.#t = tMs;
        this.#x += this.#v * dt;
        const q = this.#q;
        // P = F P F' + Q, F = [[1, dt], [0, 1]], Q from white acceleration.
        const p00 = this.#p00 + dt * (2 * this.#p01 + dt * this.#p11) + (q * dt ** 4) / 4;
        const p01 = this.#p01 + dt * this.#p11 + (q * dt ** 3) / 2;
        const p11 = this.#p11 + q * dt * dt;
        this.#p00 = p00;
        this.#p01 = p01;
        this.#p11 = p11;
    }

    /** Fuse one observation taken at `tMs`. Returns false when rejected as an outlier. */
    update(tMs: number, o: DistanceObservation): boolean {
        if (!(o.distanceM > 0.15) || !Number.isFinite(o.distanceM)) return false;
        this.predict(tMs);
        const r = o.relSigma * o.relSigma;
        const z = Math.log(o.distanceM);
        const y = z - this.#x;
        const s = this.#p00 + r;
        if ((y * y) / s > 9 && this.#rejected < 6) {
            this.#rejected++;
            return false;
        }
        this.#rejected = 0;
        const k0 = this.#p00 / s;
        const k1 = this.#p01 / s;
        this.#x += k0 * y;
        this.#v += k1 * y;
        const p00 = (1 - k0) * this.#p00;
        const p01 = (1 - k0) * this.#p01;
        const p11 = this.#p11 - k1 * this.#p01;
        this.#p00 = p00;
        this.#p01 = p01;
        this.#p11 = p11;
        return true;
    }

    reset(distanceM: number): void {
        this.#x = Math.log(distanceM);
        this.#v = 0;
        this.#p00 = 1;
        this.#p01 = 0;
        this.#p11 = 1;
        this.#t = null;
        this.#rejected = 0;
    }
}

/** What the calibration wizard measures about the owner (persisted in settings). */
export interface PersonalMetrics {
    /** Owner's standing height (m), typed by the user. */
    heightM: number;
    /** Measured personally: shoulder width (m), iris diameter (m), seated head height above the floor (m). */
    shoulderM: number;
    irisM: number;
    seatedHeadM: number;
    /** Scale correction for MediaPipe world landmarks (owner height / model-implied height). */
    worldScale: number;
}

/**
 * From a STANDING sample (camera frame, metres, +y down as MediaPipe):
 * the torso (hip centre -> shoulder centre) is vertical in the room, so its
 * direction in the camera frame gives the camera pitch; the head height above
 * the floor (from the typed body height) gives the camera height.
 * Returns tilt (deg, looking down positive) and camera height (m).
 */
export function cameraPoseFromStanding(
    hipCam: Vec3,
    shoulderCam: Vec3,
    headTopCam: Vec3,
    ownerHeightM: number,
): { tiltDeg: number; heightM: number } | null {
    // Up direction in camera coords (+y down): from hip to shoulder.
    const ux = shoulderCam[0] - hipCam[0];
    const uy = shoulderCam[1] - hipCam[1];
    const uz = shoulderCam[2] - hipCam[2];
    const l = Math.hypot(ux, uy, uz);
    if (l < 0.25) return null;
    const up: Vec3 = [ux / l, uy / l, uz / l];
    // Camera looking down by t sees the room's up as (0, -cos t, -sin t) in y-down coords... with
    // +z forward, a vertical vector tilts TOWARD the camera at the top: z decreases going up.
    const tiltDeg = (Math.atan2(-up[2], -up[1]) * 180) / Math.PI;
    if (!(tiltDeg > -30 && tiltDeg < 60)) return null;
    // Height of the camera above the floor: the head top is `ownerHeightM` above the floor.
    // A camera-frame point (y down, z forward) sits `y cos t + z sin t` BELOW the camera in
    // the room (camera pitched down by t), so camH = ownerHeight + that drop.
    const t = (tiltDeg * Math.PI) / 180;
    const drop = headTopCam[1] * Math.cos(t) + headTopCam[2] * Math.sin(t);
    const heightM = ownerHeightM + drop;
    if (!(heightM > 0.3 && heightM < 3)) return null;
    return { tiltDeg, heightM };
}
