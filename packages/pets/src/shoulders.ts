import { OneEuroPoint, type OneEuroOptions, DEFAULT_ONE_EURO } from "./one-euro.js";

/** MediaPipe Pose landmark indices we use. */
export const POSE = { nose: 0, leftShoulder: 11, rightShoulder: 12 } as const;

export interface Landmark {
    /** Normalised [0,1] image coordinates, y down. */
    x: number;
    y: number;
    visibility?: number;
}

export interface ShoulderAnchor {
    /** Pixel position of the perch point on the shoulder top, y down. */
    x: number;
    y: number;
    /** Shoulder width in pixels; the pet is scaled relative to it. */
    span: number;
    /** Head-tilt roll in radians (shoulder line angle). */
    roll: number;
    visible: boolean;
}

export type Side = "left" | "right";

/**
 * Turns raw pose landmarks into stable perch points. MediaPipe's "left" is the
 * subject's left, which appears on the image's right when not mirrored.
 */
export class ShoulderTracker {
    readonly #left: OneEuroPoint;
    readonly #right: OneEuroPoint;
    readonly #minVisibility: number;
    #lostSince: number | null = null;
    #last: Record<Side, ShoulderAnchor> | null = null;

    constructor(options: OneEuroOptions = DEFAULT_ONE_EURO, minVisibility = 0.5) {
        this.#left = new OneEuroPoint(2, options);
        this.#right = new OneEuroPoint(2, options);
        this.#minVisibility = minVisibility;
    }

    /**
     * @param landmarks pose landmarks for one person, or null when nobody is seen
     * @param width output width in px; @param height output height in px
     * @param holdMs keep the last anchor this long through dropouts
     */
    update(
        landmarks: readonly Landmark[] | null,
        width: number,
        height: number,
        tMs: number,
        holdMs = 400,
    ): Record<Side, ShoulderAnchor> | null {
        const l = landmarks?.[POSE.leftShoulder];
        const r = landmarks?.[POSE.rightShoulder];
        const ok =
            l && r && (l.visibility ?? 1) >= this.#minVisibility && (r.visibility ?? 1) >= this.#minVisibility;
        if (!ok) {
            this.#lostSince ??= tMs;
            if (this.#last && tMs - this.#lostSince < holdMs) return this.#last;
            this.#left.reset();
            this.#right.reset();
            this.#last = null;
            return null;
        }
        this.#lostSince = null;
        const [lx = 0, ly = 0] = this.#left.filter([l.x * width, l.y * height], tMs);
        const [rx = 0, ry = 0] = this.#right.filter([r.x * width, r.y * height], tMs);
        const span = Math.hypot(lx - rx, ly - ry);
        const roll = Math.atan2(ly - ry, lx - rx);
        // Perch slightly outward from the joint and up onto the top of the shoulder.
        const out = span * 0.12;
        const up = span * 0.08;
        const dirX = (lx - rx) / (span || 1);
        const dirY = (ly - ry) / (span || 1);
        const anchor = (x: number, y: number, sign: number): ShoulderAnchor => ({
            x: x + dirX * out * sign + dirY * up,
            y: y + dirY * out * sign - Math.abs(dirX) * up,
            span,
            roll,
            visible: true,
        });
        this.#last = { left: anchor(lx, ly, 1), right: anchor(rx, ry, -1) };
        return this.#last;
    }
}
