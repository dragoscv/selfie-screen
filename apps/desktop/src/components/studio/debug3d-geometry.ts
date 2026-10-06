import { focalPx, project, type BodyJoint, type Capsule, type PetDebug, type Pinhole, type Vec3 } from "@tiksee/pets";

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
        `delay ${Math.round(s.perf.delayMs)} ms`,
        `render ${s.perf.renderMs.toFixed(1)} ms ${Math.round(s.perf.fps)} fps`,
        `pets ${s.perf.petsActive}`,
    );
    return parts.join(" · ");
}

/** Second HUD line: `dist 0.93 m ±4% (body 0.95 / iris 0.91)`, or the detector fallback. */
export function distanceLine(s: Debug3dState): string {
    const m = s.metric;
    if (!m) return s.body?.present ? `dist ${metres(s.body.distanceM)} (detector)` : "dist —";
    const parts: string[] = [];
    if (m.body !== undefined) parts.push(`body ${m.body.toFixed(2)}`);
    if (m.iris !== undefined) parts.push(`iris ${m.iris.toFixed(2)}`);
    const detail = parts.length ? ` (${parts.join(" / ")})` : "";
    return `dist ${metres(m.distanceM)} ±${Math.round(m.relSigma * 100)}%${detail}`;
}

/* ------------------------------------------------------------------ *
 * Body capsules
 * ------------------------------------------------------------------ */

export interface CapsuleOutline {
    /** End circles (shell px); one circle when the capsule is a sphere (head). */
    circles: { x: number; y: number; r: number }[];
    /** Side lines tangent to both end circles (empty for a sphere). */
    sides: [{ x: number; y: number }, { x: number; y: number }][];
}

/** Projected radius (shell px) of a sphere of `rM` metres at `depthM`. */
export function projectedRadius(pin: Pinhole, rect: Rect, rM: number, depthM: number): number {
    return ((rM * focalPx(pin)) / Math.max(depthM, 0.05)) * (rect.width / pin.width);
}

/** Wireframe of a capsule: two projected end circles + two side lines (null when an end is behind the camera). */
export function capsuleOutline(pin: Pinhole, rect: Rect, c: Capsule): CapsuleOutline | null {
    const a = worldToShell(pin, rect, c.a);
    const b = worldToShell(pin, rect, c.b);
    if (!a || !b) return null;
    const ra = projectedRadius(pin, rect, c.r, a.depthM);
    const rb = projectedRadius(pin, rect, c.r, b.depthM);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return { circles: [{ x: a.x, y: a.y, r: Math.max(ra, rb) }], sides: [] };
    const nx = -dy / len;
    const ny = dx / len;
    return {
        circles: [
            { x: a.x, y: a.y, r: ra },
            { x: b.x, y: b.y, r: rb },
        ],
        sides: [
            [
                { x: a.x + nx * ra, y: a.y + ny * ra },
                { x: b.x + nx * rb, y: b.y + ny * rb },
            ],
            [
                { x: a.x - nx * ra, y: a.y - ny * ra },
                { x: b.x - nx * rb, y: b.y - ny * rb },
            ],
        ],
    };
}

/* ------------------------------------------------------------------ *
 * Mind card
 * ------------------------------------------------------------------ */

export interface UtilityBar {
    action: string;
    score: number;
    /** 0..1 of the best score shown. */
    frac: number;
    chosen: boolean;
}

/** Top `n` utility scores normalised to the max; the decided action is flagged. */
export function utilityBars(ranking: readonly { action: string; score: number }[], chosen: string | null, n = 5): UtilityBar[] {
    const top = [...ranking].sort((x, y) => y.score - x.score).slice(0, n);
    const max = Math.max(0, ...top.map((r) => r.score));
    return top.map((r) => ({
        action: r.action,
        score: r.score,
        frac: max > 0 ? Math.min(1, Math.max(0, r.score / max)) : 0,
        chosen: r.action === chosen,
    }));
}

export const NEED_KEYS = ["energy", "curiosity", "attention", "affection", "play"] as const;
export const NEED_LABELS: Readonly<Record<(typeof NEED_KEYS)[number], string>> = {
    energy: "E",
    curiosity: "C",
    attention: "A",
    affection: "Af",
    play: "P",
};

/** Needs as five clamped 0..1 bars in a fixed order. */
export function needBars(needs: PetDebug["mind"]["needs"]): { key: (typeof NEED_KEYS)[number]; label: string; frac: number }[] {
    return NEED_KEYS.map((key) => ({ key, label: NEED_LABELS[key], frac: Math.min(1, Math.max(0, needs[key])) }));
}

/**
 * Mood dot inside a `size` px square at (x, y): valence -1..1 -> left..right,
 * arousal 0..1 -> bottom..top. Values are clamped to the square.
 */
export function moodDot(mood: PetDebug["mind"]["mood"], x: number, y: number, size: number): { x: number; y: number } {
    const v = Math.min(1, Math.max(-1, mood.valence));
    const a = Math.min(1, Math.max(0, mood.arousal));
    return { x: x + ((v + 1) / 2) * size, y: y + (1 - a) * size };
}

/** Push badge text when the hard constraints moved the pet more than 5 mm, else null. */
export function pushBadge(pushedM: number): string | null {
    return pushedM > 0.005 ? `PUSH ${Math.round(pushedM * 100)} cm` : null;
}

export const CARD_W = 168;
export const CARD_H = 132;

/**
 * Card top-left: beside the pet's contact point (`at`, shell px) when it fits
 * in `rect`, otherwise stacked in the top-right corner by `slot`.
 */
export function cardPosition(rect: Rect, at: { x: number; y: number } | null, slot: number, w = CARD_W, h = CARD_H): { x: number; y: number } {
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    if (at && at.x >= rect.left && at.x <= right && at.y >= rect.top && at.y <= bottom) {
        // Prefer the right of the pet; flip left near the edge; keep inside vertically.
        let x = at.x + 70;
        if (x + w > right - 4) x = at.x - 70 - w;
        x = Math.min(right - w - 4, Math.max(rect.left + 4, x));
        const y = Math.min(bottom - h - 4, Math.max(rect.top + 56, at.y - h / 2));
        return { x, y };
    }
    return { x: right - w - 8, y: rect.top + 56 + slot * (h + 6) };
}
