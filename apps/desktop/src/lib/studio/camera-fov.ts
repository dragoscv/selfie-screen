import type { StudioSettings } from "@tiksee/core";
import { CAMERA_PRESETS, lensVfov, type Rotation } from "@tiksee/pets";

/**
 * Raw-frame vertical FOV in use. While `space.fovSource` is "preset" the camera
 * preset (+ lens mm) is the truth, so a stale stored `vfovDeg` (old default 60)
 * can never size the 3D world wrongly; measured / manual values win otherwise.
 */
export function cameraVfov(s: Pick<StudioSettings, "vfovDeg" | "cameraPreset" | "lensMm" | "space">): number {
    if (s.space.fovSource !== "preset" || s.cameraPreset === "custom") return s.vfovDeg;
    const p = CAMERA_PRESETS[s.cameraPreset];
    return "sensorHeightMm" in p ? lensVfov(s.lensMm, p.sensorHeightMm) : p.vfovDeg;
}

/**
 * vFOV is measured over the RAW frame height (lens presets, ChArUco and the metric
 * solves all use rawH). A camera mounted at 90/270 degrees is shown upright, so the
 * upright frame's vertical extent is the RAW WIDTH: widen accordingly.
 */
export function uprightVfov(rawVfovDeg: number, rotation: Rotation, rawW: number, rawH: number): number {
    if (rotation !== 90 && rotation !== 270) return rawVfovDeg;
    const half = Math.tan((rawVfovDeg * Math.PI) / 360) * (rawW / Math.max(rawH, 1));
    return (Math.atan(half) * 360) / Math.PI;
}
