import { IRIS_DIAMETER_M, cameraPoseFromStanding, focalFromVfov, type Vec3 } from "@tiksee/pets";

import type { SpaceSample } from "./controller.js";
import type { MetricConfig, MetricDistance, PoseForDistance } from "./metric-distance.js";

/**
 * Aggregate a space-calibration window of early pose results into the owner's
 * metric measures (medians, so a few bad frames do not matter).
 * Camera frame here = MediaPipe image convention: +x right, +y DOWN, +z forward.
 */

const median = (a: number[]): number | undefined => {
    if (a.length === 0) return undefined;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

const MIN_FRAMES = 8;

/** A world landmark moved into the camera frame: world (hip-centred, scaled) + root translation. */
function camPoint(w: { x: number; y: number; z: number }, t: Vec3, s: number): Vec3 {
    return [w.x * s + t[0], w.y * s + t[1], w.z * s + t[2]];
}

export function aggregateSpace(
    kind: "standing" | "seated",
    frames: readonly PoseForDistance[],
    cfg: MetricConfig,
    ownerHeightM: number,
    metric: MetricDistance,
    current: { tiltDeg: number; heightM: number },
): SpaceSample {
    const issues: SpaceSample["issues"] = [];
    const usable = frames.filter((f) => f.pose && f.world);
    if (usable.length < MIN_FRAMES) return { kind, frames: usable.length, issues: ["noBody"] };
    const scale = cfg.worldScale > 0 ? cfg.worldScale : 1;
    const dist: number[] = [];
    const shoulders: number[] = [];
    const iris: number[] = [];
    const modelH: number[] = [];
    const tilts: number[] = [];
    const camHs: number[] = [];
    const headH: number[] = [];
    let headOut = 0;
    let feetOut = 0;
    for (const f of usable) {
        const world = f.world;
        const pose = f.pose;
        if (!world || !pose) continue;
        const solved = metric.bodyDistance(f, cfg);
        if (!solved) continue;
        dist.push(solved.distanceM);
        const ls = world[11];
        const rs = world[12];
        if (ls && rs) shoulders.push(Math.hypot(ls.x - rs.x, ls.y - rs.y, ls.z - rs.z) * scale);
        const k = focalFromVfov(cfg.cameraVfovDeg, f.rawH);
        if (f.irisPx !== null && f.irisAgeMs < 150 && f.irisPx >= 14) {
            // Personal iris (m) = px * distance / f, with the eyes ~0.08 m in front of the torso.
            iris.push((f.irisPx * (solved.distanceM - 0.08)) / k);
        }
        const nose = pose[0];
        if (!nose || nose.y < 0.02) headOut++;
        // Model height: lowest ankle/heel to nose top (+0.1 m crown) in world landmarks.
        const feet = [27, 28, 29, 30].map((i) => world[i]).filter((w): w is NonNullable<typeof w> => !!w && w.visibility > 0.5);
        const feetVisible = [27, 28].every((i) => {
            const p = pose[i];
            return !!p && p.y < 0.99 && (p.visibility ?? 0) > 0.5;
        });
        if (!feetVisible) feetOut++;
        const w0 = world[0];
        if (feet.length && w0 && feetVisible) {
            const lowest = Math.max(...feet.map((w) => w.y));
            modelH.push((lowest - w0.y + 0.1) * scale);
        }
        if (kind === "standing" && ownerHeightM > 0) {
            // Root translation in camera coords: re-solve from the image (x/y) using the body distance.
            const lh = world[23];
            const rh = world[24];
            if (!lh || !rh || !ls || !rs || !w0) continue;
            const fx = k;
            const hipImg = pose[23] && pose[24] ? { x: (pose[23].x + pose[24].x) / 2, y: (pose[23].y + pose[24].y) / 2 } : null;
            if (!hipImg) continue;
            // Hip centre in camera frame from its pixel and the solved depth (hips ≈ root).
            const zHip = solved.distanceM - ((ls.z + rs.z) / 2) * scale;
            const t: Vec3 = [((hipImg.x * f.rawW - f.rawW / 2) * zHip) / fx, ((hipImg.y * f.rawH - f.rawH / 2) * zHip) / fx, zHip];
            const hip = camPoint({ x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: (lh.z + rh.z) / 2 }, t, scale);
            const sh = camPoint({ x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, z: (ls.z + rs.z) / 2 }, t, scale);
            const top = camPoint({ x: w0.x, y: w0.y - 0.1, z: w0.z }, t, scale);
            const pose3 = cameraPoseFromStanding(hip, sh, top, ownerHeightM);
            if (pose3) {
                tilts.push(pose3.tiltDeg);
                camHs.push(pose3.heightM);
            }
        }
        if (kind === "seated" && w0) {
            // Head height above the floor with the current camera pose: camera height minus the
            // drop of the nose along room vertical.
            const t = (current.tiltDeg * Math.PI) / 180;
            const noseZ = solved.distanceM - 0.08;
            const noseY = ((nose?.y ?? 0.5) * f.rawH - f.rawH / 2) * noseZ / k;
            headH.push(current.heightM - (noseY * Math.cos(t) + noseZ * Math.sin(t)));
        }
    }
    if (headOut > usable.length / 2) issues.push("headOut");
    if (kind === "standing" && feetOut > usable.length / 2) issues.push("notFullBody");
    if (iris.length < MIN_FRAMES / 2) issues.push("smallIris");
    const dMed = median(dist);
    if (dist.length >= MIN_FRAMES && dMed !== undefined) {
        const spread = (median(dist.map((d) => Math.abs(d - dMed))) ?? 0) / dMed;
        if (spread > 0.06) issues.push("unstable");
    }
    const out: SpaceSample = { kind, frames: usable.length, issues };
    if (dMed !== undefined) out.distanceM = dMed;
    const sh = median(shoulders);
    if (sh !== undefined) out.shoulderM = sh;
    const ir = median(iris);
    if (ir !== undefined && ir > IRIS_DIAMETER_M * 0.7 && ir < IRIS_DIAMETER_M * 1.3) out.irisM = ir;
    const mh = median(modelH);
    if (mh !== undefined) out.modelHeightM = mh;
    const tl = median(tilts);
    const ch = median(camHs);
    if (tl !== undefined && ch !== undefined) {
        out.tiltDeg = tl;
        out.heightM = ch;
    }
    const hh = median(headH);
    if (hh !== undefined) out.headHeightM = hh;
    return out;
}
