/**
 * Synthetic landmark fixtures for the unit tests (not exported from index).
 * Hands: palm = 100 px (wrist -> middle MCP), fingers up, thumb on the left.
 */
import type { Pt } from "./geometry.js";

export type FingerSpec = boolean | "pinch";

export interface HandSpec {
    thumb?: boolean;
    index?: FingerSpec;
    middle?: boolean;
    ring?: boolean;
    pinky?: boolean;
    /** Degrees; -90 = fingers point left, 90 = right, 180 = down. */
    rotate?: number;
    scale?: number;
    at?: Pt;
}

function finger(x: number, extended: boolean): Pt[] {
    // MCP, PIP, DIP, TIP
    return extended
        ? [
              { x, y: -100 },
              { x, y: -140 },
              { x, y: -165 },
              { x, y: -190 },
          ]
        : [
              { x, y: -100 },
              { x, y: -130 },
              { x, y: -112 },
              { x, y: -95 },
          ];
}

export function makeHand(spec: HandSpec = {}): Pt[] {
    const pinch = spec.index === "pinch";
    const thumb: Pt[] = pinch
        ? [
              { x: -25, y: -20 },
              { x: -40, y: -60 },
              { x: -50, y: -110 },
              { x: -55, y: -150 },
          ]
        : spec.thumb
          ? [
                { x: -25, y: -20 },
                { x: -40, y: -30 },
                { x: -65, y: -45 },
                { x: -90, y: -60 },
            ]
          : [
                { x: -25, y: -20 },
                { x: -40, y: -30 },
                { x: -30, y: -55 },
                { x: -5, y: -65 },
            ];
    const index = pinch
        ? [
              { x: -30, y: -100 },
              { x: -30, y: -140 },
              { x: -42, y: -152 },
              { x: -50, y: -160 },
          ]
        : finger(-30, spec.index === true);
    const pts: Pt[] = [
        { x: 0, y: 0 },
        ...thumb,
        ...index,
        ...finger(-10, spec.middle ?? false),
        ...finger(10, spec.ring ?? false),
        ...finger(30, spec.pinky ?? false),
    ];
    const a = ((spec.rotate ?? 0) * Math.PI) / 180;
    const s = spec.scale ?? 1;
    const o = spec.at ?? { x: 500, y: 500 };
    return pts.map((p) => ({
        x: o.x + s * (p.x * Math.cos(a) - p.y * Math.sin(a)),
        y: o.y + s * (p.x * Math.sin(a) + p.y * Math.cos(a)),
    }));
}

export const OPEN: HandSpec = { thumb: true, index: true, middle: true, ring: true, pinky: true };

/** 33 pose landmarks of a seated, upright subject; shoulders 200 px apart. */
export function makePose(over: Partial<Record<number, Pt>> = {}): Pt[] {
    const pts: Pt[] = Array.from({ length: 33 }, () => ({ x: 500, y: 600, visibility: 0.1 }));
    const set = (i: number, x: number, y: number, visibility = 0.99) => (pts[i] = { x, y, visibility });
    set(0, 500, 350); // nose
    set(2, 480, 330); // left eye
    set(5, 520, 330); // right eye
    set(7, 460, 340);
    set(8, 540, 340);
    set(11, 400, 500); // left shoulder
    set(12, 600, 500); // right shoulder
    set(13, 380, 650); // left elbow
    set(14, 620, 650);
    set(15, 390, 780); // left wrist
    set(16, 610, 780);
    set(23, 430, 900, 0.2); // hips mostly out of frame
    set(24, 570, 900, 0.2);
    for (const [k, v] of Object.entries(over)) if (v) pts[Number(k)] = { visibility: 0.99, ...v };
    return pts;
}
