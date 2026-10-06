import {
    DistanceFilter,
    IRIS_DIAMETER_M,
    focalFromVfov,
    irisDistance,
    solveRootTranslation,
    type CameraIntrinsics,
    type SolveJoint,
} from "@tiksee/pets";

/**
 * Owner distance (m) from one camera, fused per pose result:
 *  - whole-body solve of the root translation from MediaPipe world landmarks
 *    (metric, scaled by the owner's calibrated `worldScale`) against the image
 *    landmarks in RAW camera px;
 *  - iris diameter (personal value after calibration, else 11.7 mm);
 *  - Kalman on log distance with outlier gating.
 * The result is the distance of the TORSO (shoulder midpoint) along the optical axis.
 */

/** Joints used by the solve: upper body + face (hips/legs are often off-frame for a seated streamer). */
const SOLVE_JOINTS = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24] as const;

export interface PoseForDistance {
    tMs: number;
    pose: readonly { x: number; y: number; visibility?: number }[] | null;
    world: readonly { x: number; y: number; z: number; visibility: number }[] | null;
    rawW: number;
    rawH: number;
    irisPx: number | null;
    irisAgeMs: number;
}

export interface MetricConfig {
    /** Vertical FOV of the RAW camera frame (deg). */
    cameraVfovDeg: number;
    /** Owner calibration (0 = unknown). */
    worldScale: number;
    irisM: number;
}

export interface MetricReading {
    distanceM: number;
    relSigma: number;
    body?: { distanceM: number; residualPx: number };
    iris?: { distanceM: number };
}

export class MetricDistance {
    readonly #filter = new DistanceFilter(1);
    #last: MetricReading | null = null;

    get reading(): MetricReading | null {
        return this.#last;
    }

    intrinsics(cfg: MetricConfig, rawW: number, rawH: number): CameraIntrinsics {
        return { fPx: focalFromVfov(cfg.cameraVfovDeg, rawH), cx: rawW / 2, cy: rawH / 2 };
    }

    /** Body-solve distance (m) of the shoulder midpoint for one pose; null when it cannot be solved. */
    bodyDistance(p: PoseForDistance, cfg: MetricConfig): { distanceM: number; residualPx: number } | null {
        if (!p.pose || !p.world) return null;
        const k = this.intrinsics(cfg, p.rawW, p.rawH);
        const s = cfg.worldScale > 0 ? cfg.worldScale : 1;
        const joints: SolveJoint[] = [];
        for (const i of SOLVE_JOINTS) {
            const im = p.pose[i];
            const w = p.world[i];
            if (!im || !w) continue;
            const vis = Math.min(im.visibility ?? 1, w.visibility || 1);
            // Off-frame landmarks are hallucinated: ignore them.
            if (im.x < 0.01 || im.x > 0.99 || im.y < 0.01 || im.y > 0.99) continue;
            joints.push({ u: im.x * p.rawW, v: im.y * p.rawH, world: [w.x * s, w.y * s, w.z * s], weight: vis });
        }
        const r = solveRootTranslation(joints, k);
        if (!r) return null;
        // Distance of the shoulder midpoint (root = hip centre in world coords).
        const ls = p.world[11];
        const rs = p.world[12];
        const shoulderZ = ls && rs ? ((ls.z + rs.z) / 2) * s : 0;
        return { distanceM: r.t[2] + shoulderZ, residualPx: r.residualPx };
    }

    /** Fuse one pose result; returns the filtered torso distance. */
    update(p: PoseForDistance, cfg: MetricConfig): MetricReading | null {
        const body = this.bodyDistance(p, cfg);
        const out: MetricReading = { distanceM: this.#filter.distanceM, relSigma: this.#filter.relSigma };
        if (body && body.residualPx < 0.05 * p.rawH) {
            // Larger reprojection error = less trust; 5 % base.
            const rel = 0.05 + Math.min(0.15, body.residualPx / p.rawH);
            this.#filter.update(p.tMs, { distanceM: body.distanceM, relSigma: rel, source: "body" });
            out.body = body;
        }
        if (p.irisPx !== null && p.irisAgeMs < 150) {
            const k = this.intrinsics(cfg, p.rawW, p.rawH);
            const eyes = irisDistance(p.irisPx, k.fPx, cfg.irisM > 0 ? cfg.irisM : IRIS_DIAMETER_M);
            if (eyes !== null) {
                // Eyes sit ~0.08 m in front of the shoulder line for an upright streamer.
                const torso = eyes + 0.08;
                const rel = Math.hypot(cfg.irisM > 0 ? 0.02 : 0.043, 1.5 / p.irisPx);
                this.#filter.update(p.tMs, { distanceM: torso, relSigma: rel, source: "iris" });
                out.iris = { distanceM: torso };
            }
        }
        if (!out.body && !out.iris) return this.#last;
        out.distanceM = this.#filter.distanceM;
        out.relSigma = this.#filter.relSigma;
        this.#last = out;
        return out;
    }

    reset(distanceM = 1): void {
        this.#filter.reset(distanceM);
        this.#last = null;
    }
}
