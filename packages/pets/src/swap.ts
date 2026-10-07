/**
 * Pet switch morph: the old pet shrinks, squashes and spins out while the new one pops in at the
 * same spot with an elastic stretch, so a swap reads as one creature morphing into another
 * instead of a cut. Pure curves (unit-tested); the stage applies them to scale, yaw and fade.
 */

/** Old pet leaving (s). */
export const SWAP_OUT_S = 0.4;
/** New pet arriving (s); it starts when the old one is half gone, so the two overlap. */
export const SWAP_IN_S = 0.75;
export const SWAP_OVERLAP_S = SWAP_OUT_S * 0.5;

export interface SwapShape {
    /** Uniform scale multiplier (0..~1.15). */
    scale: number;
    /** Extra vertical stretch (>1 = taller, <1 = squashed); horizontal gets 1/sqrt to keep volume. */
    stretch: number;
    /** Extra yaw (radians). */
    spin: number;
    /** 0..1 visibility. */
    alpha: number;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Old pet at `t` seconds into the swap: anticipation (tiny grow), then a squashed spin into nothing. */
export function swapOut(t: number): SwapShape {
    const k = clamp01(t / SWAP_OUT_S);
    // Anticipation: +8 % in the first fifth, then a smoothstep shrink to zero (gentle at both ends).
    const grow = 1 + 0.08 * Math.sin(Math.PI * clamp01(k / 0.4));
    const shrink = 1 - (k * k * (3 - 2 * k));
    const scale = Math.max(0, grow * shrink);
    return { scale, stretch: 1 - 0.35 * Math.sin(Math.PI * k), spin: k * k * Math.PI * 0.9, alpha: 1 - clamp01((k - 0.35) / 0.65) };
}

/**
 * New pet at `t` seconds since it appeared: elastic pop (overshoot ~12 %, settles by SWAP_IN_S),
 * a vertical stretch that relaxes into a small squash and back, and an unwinding spin.
 */
export function swapIn(t: number): SwapShape {
    const k = clamp01(t / SWAP_IN_S);
    // Damped spring from 0 to 1 with an eased start: overshoot (~12 %) then settle.
    const e = k * k * (3 - 2 * k);
    const scale = k >= 1 ? 1 : Math.max(0, 1 - Math.exp(-5 * e) * Math.cos(1.9 * Math.PI * e));
    const stretch = k >= 1 ? 1 : 1 + 0.3 * Math.exp(-5 * k) * Math.cos(3 * Math.PI * k);
    const spin = -(1 - k) * (1 - k) * Math.PI * 0.6;
    return { scale, stretch, spin, alpha: clamp01(k / 0.25) };
}
