import { focalPx, project, type BodyJoint, type Pinhole, type Vec3 } from "@tiksee/pets";

import type { Debug3dState } from "../../lib/studio/controller.js";
import type { Rect } from "./geometry.js";

/**
 * Pure geometry for the 3D debug overlay (debug3d.tsx): grid generation,
 * frustum clipping, pet boxes, depth colours and the HUD line. World frame and
 * projection come from @tiksee/pets space.ts (metres, +Y up, camera looks -Z).
 */

export interface Segment {
    a: Vec3;
    b: Vec3;
    /** Mean depth (m) of the segment, for fading. */
    depthM: number;
}

/** Depth range the overlay colours and fades over. */
export const NEAR_M = 0.3;
export const FAR_M = 4;
export const GRID_STEP_M = 0.25;
/** Depth labels on the floor grid. */
export const DEPTH_MARKS_M = [0.5, 1, 2, 3] as const;

/** Bones drawn between BODY_JOINTS (image side does not matter: both are drawn). */
export const BONES: readonly (readonly [BodyJoint, BodyJoint])[] = [
    ["leftShoulder", "rightShoulder"],
    ["leftShoulder", "leftElbow"],
    ["leftElbow", "leftWrist"],
    ["rightShoulder", "rightElbow"],
    ["rightElbow", "rightWrist"],
    ["leftShoulder", "leftHip"],
    ["rightShoulder", "rightHip"],
    ["leftHip", "rightHip"],
    ["leftEar", "leftEye"],
    ["leftEye", "nose"],
    ["nose", "rightEye"],
    ["rightEye", "rightEar"],
];

/** Half-angle tangents of the output frustum. */
export function frustumTan(pin: Pinhole): { h: number; v: number } {
    const f = focalPx(pin);
    return { h: pin.width / 2 / f, v: pin.height / 2 / f };
}

/**
 * Horizontal grid at room height `y` (0 = the floor) from `near` to `far`
 * metres in front of the camera (room -Z), `step` spacing, split into cells.
 * Only cells whose centre projects inside the image (with a margin) and lies
 * in front of the camera are kept, so the grid never draws "through" the
 * owner: `maxZ` (room -Z distance) stops it at the owner's body plane.
 */
export function floorGrid(pin: Pinhole, y: number, near = NEAR_M, far = FAR_M, step = GRID_STEP_M, maxZ = Infinity): Segment[] {
    const out: Segment[] = [];
    const zEnd = Math.min(far, maxZ);
    const tan = frustumTan(pin);
    const xMax = Math.ceil((far * tan.h) / step) * step;
    const visible = (p: Vec3): number | null => {
        const s = project(pin, p);
        return s.depthM > 0.1 && s.u > -0.05 && s.u < 1.05 && s.v > -0.05 && s.v < 1.05 ? s.depthM : null;
    };
    for (let z = Math.ceil(near / step) * step; z <= zEnd + 1e-9; z += step) {
        for (let x = -xMax; x < xMax - 1e-9; x += step) {
            // Cell edges: across (constant z) and along (constant x).
            const across: Segment = { a: [x, y, -z], b: [x + step, y, -z], depthM: 0 };
            const along: Segment = { a: [x, y, -z], b: [x, y, -Math.min(z + step, zEnd)], depthM: 0 };
            for (const seg of z + step <= zEnd + 1e-9 ? [across, along] : [across]) {
                const da = visible(seg.a);
                const db = visible(seg.b);
                if (da === null || db === null) continue;
                out.push({ ...seg, depthM: (da + db) / 2 });
            }
        }
    }
    return out;
}

/** Vertical metric grid (default 1 m wide × 2 m tall) centred on (cx, cy) at `depthM`. */
export function wallGrid(cx: number, cy: number, depthM: number, widthM = 1, heightM = 2, step = GRID_STEP_M): Segment[] {
    const out: Segment[] = [];
    const z = -depthM;
    const x0 = cx - widthM / 2;
    const y0 = cy - heightM / 2;
    for (let i = 0; i <= Math.round(widthM / step); i++) {
        const x = x0 + i * step;
        out.push({ a: [x, y0, z], b: [x, y0 + heightM, z], depthM });
    }
    for (let i = 0; i <= Math.round(heightM / step); i++) {
        const y = y0 + i * step;
        out.push({ a: [x0, y, z], b: [x0 + widthM, y, z], depthM });
    }
    return out;
}

/** Rotate `v` around +Y by `yaw` radians. */
export function rotateY(v: Vec3, yaw: number): Vec3 {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Box edges (12) as corner index pairs: 0-3 bottom ring, 4-7 top ring. */
export const BOX_EDGES: readonly (readonly [number, number])[] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
];

/** 8 corners of a pet box standing on contact point `p`, rotated by `yaw`. */
export function petBox(p: Vec3, yaw: number, halfM = 0.06, heightM = 0.2): Vec3[] {
    const ring: Vec3[] = [
        [-halfM, 0, -halfM],
        [halfM, 0, -halfM],
        [halfM, 0, halfM],
        [-halfM, 0, halfM],
    ];
    const bottom = ring.map((c) => add3(p, rotateY(c, yaw)));
    const top = bottom.map((c) => add3(c, [0, heightM, 0]));
    return [...bottom, ...top];
}

/** Facing direction of a pet (yaw 0 = towards the camera, +Z). */
export function facing(yaw: number): Vec3 {
    return rotateY([0, 0, 1], yaw);
}

/** Output-normalised (u, v down) -> shell px. */
export function toShell(rect: Rect, u: number, v: number): { x: number; y: number } {
    return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
}

/** World point -> shell px, or null when behind / too close to the camera. */
export function worldToShell(pin: Pinhole, rect: Rect, p: Vec3): { x: number; y: number; depthM: number } | null {
    const s = project(pin, p);
    if (s.depthM < 0.05) return null;
    return { ...toShell(rect, s.u, s.v), depthM: s.depthM };
}

/** 0 (near) .. 1 (far) position on the depth ramp; monotonic in depth. */
export function depthT(depthM: number, near = NEAR_M, far = FAR_M): number {
    const t = (Math.log(Math.max(depthM, near)) - Math.log(near)) / (Math.log(far) - Math.log(near));
    return Math.min(1, Math.max(0, t));
}

/** Turbo-like ramp: red (near) -> yellow -> green -> cyan -> blue (far). Hue strictly increases with depth. */
export function depthHue(depthM: number): number {
    return depthT(depthM) * 230;
}

export function depthColor(depthM: number, alpha = 1): string {
    return `hsl(${depthHue(depthM).toFixed(1)} 95% 58% / ${alpha.toFixed(3)})`;
}

/** Joint dot radius in px: nearer = larger, clamped. */
export function dotRadius(depthM: number): number {
    return Math.min(9, Math.max(2.5, 6 / Math.max(depthM, 0.2)));
}

/** Grid line opacity fading with depth. */
export function fadeAlpha(depthM: number): number {
    return 0.55 * (1 - depthT(depthM)) + 0.08;
}

/** Number formatting the HUD and labels share. */
export const metres = (m: number): string => `${m.toFixed(2)} m`;

/** HUD line: `vFOV 60.0° · focal 1663 px · owner 0.94 m · yaw 12° · pose 18 Hz (age 42 ms) · render 2.1 ms 60 fps · pets 2`. */
export function hudLine(s: Debug3dState): string {
    const parts = [`vFOV ${s.pin.vfovDeg.toFixed(1)}°`, `focal ${Math.round(focalPx(s.pin))} px`];
    if (s.body?.present) {
        parts.push(`owner ${metres(s.body.distanceM)}`, `yaw ${Math.round((s.body.yaw * 180) / Math.PI)}°`);
    } else {
        parts.push("owner —");
    }
    parts.push(
        `pose ${Math.round(s.perf.poseHz)} Hz (age ${Math.round(s.perf.poseAgeMs)} ms)`,
        `render ${s.perf.renderMs.toFixed(1)} ms ${Math.round(s.perf.fps)} fps`,
        `pets ${s.perf.petsActive}`,
    );
    return parts.join(" · ");
}
