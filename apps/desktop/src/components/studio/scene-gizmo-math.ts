/** Pure drag maths for the in-view 3D gizmo (scene-gizmo.tsx), unit-tested. */

export type GizmoMode = "move" | "x" | "y" | "z" | "scale" | "rotate";

export interface GizmoStart {
    /** Output-normalised centre (x right, y down), metres from the camera, size, yaw/roll degrees. */
    x: number;
    y: number;
    z: number;
    size: number;
    yaw: number;
    pitch: number;
    roll: number;
    /** Pitch limit for this object (AR 90°, pets 60°). */
    pitchMax: number;
    sizeMin: number;
    sizeMax: number;
    /** Pointer and object centre at drag start (shell px), and pointer->centre distance. */
    px?: number;
    py?: number;
    cx?: number;
    cy?: number;
    dist?: number;
}

export interface GizmoResult {
    x: number;
    y: number;
    z: number;
    size: number;
    yaw: number;
    pitch: number;
    roll: number;
}

export const Z_MIN = 0.3;
export const Z_MAX = 6;
/** Pixels of drag along the Z arrow per e-fold of depth (~160 px doubles it in ~110 px). */
export const Z_PX_PER_E = 160;
/** Degrees of turn per pixel of horizontal drag on the ring. */
export const DEG_PER_PX = 0.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const PET_SCALE_MIN = 0.4;
export const PET_SCALE_MAX = 2.5;

/** Editable state of a scene object (AR: its settings; pet: its pin, else where it is now). */
export function startOf(
    s: {
        arObjects: readonly { id: string; x: number; y: number; z: number; size: number; yaw: number; pitch: number; rotation: number }[];
        petPins: Readonly<Record<string, { x: number; y: number; z: number; yaw: number; pitch: number }>>;
        petHands: { scale: Readonly<Record<string, number>> };
    },
    o: { kind: "ar" | "pet"; id: string; box: { x: number; y: number; w: number; h: number }; z: number },
): GizmoStart | null {
    if (o.kind === "ar") {
        const a = s.arObjects.find((x) => x.id === o.id);
        if (!a) return null;
        return { x: a.x, y: a.y, z: a.z, size: a.size, yaw: a.yaw, pitch: a.pitch, pitchMax: 90, roll: a.rotation, sizeMin: 0.02, sizeMax: 3 };
    }
    const pin = s.petPins[o.id];
    return {
        x: pin?.x ?? o.box.x + o.box.w / 2,
        y: pin?.y ?? o.box.y + o.box.h / 2,
        z: pin?.z ?? o.z,
        size: s.petHands.scale[o.id] ?? 1,
        yaw: pin?.yaw ?? 0,
        pitch: pin?.pitch ?? 0,
        pitchMax: 60,
        roll: 0,
        sizeMin: PET_SCALE_MIN,
        sizeMax: PET_SCALE_MAX,
    };
}

/** Wrap degrees into [-180, 180]. */
export function wrapDeg(d: number): number {
    const r = ((((d + 180) % 360) + 360) % 360) - 180;
    return r === -180 ? 180 : r;
}

/**
 * New object state for a drag from `s` to pointer (px, py). `w`/`h` = displayed image size in px.
 * move = screen plane; x / y = one axis; z = depth only along the up-right arrow (up-right =
 * farther, multiplicative so it feels the same near and far, the object stays on its screen spot);
 * scale = pointer distance from the centre, 1:1; rotate = horizontal drag turns yaw (or roll).
 */
export function gizmoDrag(s: GizmoStart & { mode: GizmoMode }, px: number, py: number, w: number, h: number, roll = false): GizmoResult {
    const dx = px - (s.px ?? px);
    const dy = py - (s.py ?? py);
    const out: GizmoResult = { x: s.x, y: s.y, z: s.z, size: s.size, yaw: s.yaw, pitch: s.pitch, roll: s.roll };
    switch (s.mode) {
        case "move":
            out.x = clamp(s.x + dx / w, -0.5, 1.5);
            out.y = clamp(s.y + dy / h, -0.5, 1.5);
            break;
        case "x":
            out.x = clamp(s.x + dx / w, -0.5, 1.5);
            break;
        case "y":
            out.y = clamp(s.y + dy / h, -0.5, 1.5);
            break;
        case "z": {
            const along = (dx - dy) * Math.SQRT1_2;
            out.z = clamp(s.z * Math.exp(along / Z_PX_PER_E), Z_MIN, Z_MAX);
            break;
        }
        case "scale": {
            const d = Math.hypot(px - (s.cx ?? px), py - (s.cy ?? py));
            out.size = clamp(s.size * (d / Math.max(s.dist ?? 1, 1)), s.sizeMin, s.sizeMax);
            break;
        }
        case "rotate":
            // Like orbiting a model: left/right turns (yaw, both ways, wraps), up/down tilts
            // (pitch: drag down = top comes towards you). Shift = roll on screen instead.
            if (roll) out.roll = clamp(Math.round(s.roll + dx * DEG_PER_PX), -180, 180);
            else {
                out.yaw = Math.round(wrapDeg(s.yaw + dx * DEG_PER_PX));
                out.pitch = clamp(Math.round(s.pitch + dy * DEG_PER_PX), -s.pitchMax, s.pitchMax);
            }
            break;
    }
    return out;
}
