import { countReversals, mean, stddev, wrapPi, type Pt } from "./geometry.js";
import type { Pulse, Side } from "./types.js";

/**
 * Dynamic hand gestures from the palm-centre trajectory of ONE hand.
 *
 * Input: palm centre in display space NORMALISED to the upright frame
 * (0..1 on both axes, y down, mirrored like the preview), so swipe_right is
 * "to the right of the streamer's preview" and 0.25 means a quarter frame.
 */
export interface MotionOptions {
    swipeWindowMs: number;
    swipeMinDistance: number;
    swipeStraightness: number;
    refractoryMs: number;
    circleWindowMs: number;
    circleMinRadius: number;
    waveWindowMs: number;
    waveReversals: number;
    waveAmplitude: number;
    /** Missing samples are tolerated this long before the trajectory is dropped, ms. */
    graceMs: number;
}

export const DEFAULT_MOTION: MotionOptions = {
    swipeWindowMs: 500,
    swipeMinDistance: 0.25,
    swipeStraightness: 0.8,
    refractoryMs: 800,
    circleWindowMs: 1600,
    circleMinRadius: 0.04,
    waveWindowMs: 1200,
    waveReversals: 3,
    waveAmplitude: 0.03,
    graceMs: 150,
};

interface Sample {
    t: number;
    x: number;
    y: number;
}

export class MotionAnalyzer {
    readonly #o: MotionOptions;
    readonly #side: Side | undefined;
    #buf: Sample[] = [];
    #lastFire = -Infinity;
    #lastSeen = -Infinity;

    constructor(side?: Side, options: Partial<MotionOptions> = {}) {
        this.#o = { ...DEFAULT_MOTION, ...options };
        this.#side = side;
    }

    /**
     * Feed one palm centre (null = hand not seen this frame). The trajectory survives gaps up to
     * `graceMs` (time-based: one dropped detection does not reset a swipe) and is cleared after.
     * `open` = the hand is an open palm (waves need it; swipes and circles do not).
     */
    update(p: Pt | null, tMs: number, open = true): Pulse[] {
        const o = this.#o;
        if (tMs - this.#lastSeen > o.graceMs) this.#buf = [];
        if (!p) {
            return [];
        }
        this.#lastSeen = tMs;
        this.#buf.push({ t: tMs, x: p.x, y: p.y });
        const keep = Math.max(o.swipeWindowMs, o.circleWindowMs, o.waveWindowMs);
        while (this.#buf.length > 0 && tMs - (this.#buf[0]?.t ?? tMs) > keep) this.#buf.shift();
        if (tMs - this.#lastFire < o.refractoryMs) return [];

        const pulse = this.#swipe(tMs) ?? this.#circle(tMs) ?? (open ? this.#wave(tMs) : null);
        if (!pulse) return [];
        this.#lastFire = tMs;
        this.#buf = [];
        return [this.#side ? { ...pulse, hand: this.#side } : pulse];
    }

    #window(tMs: number, ms: number): Sample[] {
        return this.#buf.filter((s) => tMs - s.t <= ms);
    }

    #swipe(tMs: number): Pulse | null {
        const o = this.#o;
        const w = this.#window(tMs, o.swipeWindowMs);
        const first = w[0];
        const last = w[w.length - 1];
        if (!first || !last || w.length < 3) return null;
        const dx = last.x - first.x;
        const dy = last.y - first.y;
        const disp = Math.hypot(dx, dy);
        if (disp < o.swipeMinDistance) return null;
        let path = 0;
        for (let i = 1; i < w.length; i++) {
            const a = w[i - 1];
            const b = w[i];
            if (a && b) path += Math.hypot(b.x - a.x, b.y - a.y);
        }
        const straight = path > 0 ? disp / path : 0;
        if (straight < o.swipeStraightness) return null;
        const speed = disp / Math.max((last.t - first.t) / 1000, 1e-3);
        const confidence = Math.min(1, 0.5 * straight + 0.5 * Math.min(1, disp / (2 * o.swipeMinDistance)));
        if (Math.abs(dx) >= Math.abs(dy)) return { signal: dx > 0 ? "swipe_right" : "swipe_left", confidence, value: speed };
        return { signal: dy > 0 ? "swipe_down" : "swipe_up", confidence, value: speed };
    }

    #circle(tMs: number): Pulse | null {
        const o = this.#o;
        const w = this.#window(tMs, o.circleWindowMs);
        if (w.length < 8) return null;
        const c = mean(w);
        const radii = w.map((s) => Math.hypot(s.x - c.x, s.y - c.y));
        const radius = radii.reduce((a, b) => a + b, 0) / radii.length;
        if (radius < o.circleMinRadius) return null;
        // A circle keeps a roughly constant radius and a roundish bounding box; a wave is flat.
        if (stddev(radii) / radius > 0.35) return null;
        const xs = w.map((s) => s.x);
        const ys = w.map((s) => s.y);
        const bw = Math.max(...xs) - Math.min(...xs);
        const bh = Math.max(...ys) - Math.min(...ys);
        if (bh <= 0 || bw / bh > 2.2 || bw / bh < 0.45) return null;
        let total = 0;
        let prev: number | null = null;
        for (const s of w) {
            const a = Math.atan2(s.y - c.y, s.x - c.x);
            if (prev !== null) total += wrapPi(a - prev);
            prev = a;
        }
        if (Math.abs(total) < 2 * Math.PI * 0.9) return null;
        // value: +1 clockwise on screen (y down), -1 counter-clockwise.
        return { signal: "circle", confidence: Math.min(1, Math.abs(total) / (2 * Math.PI)), value: total > 0 ? 1 : -1 };
    }

    #wave(tMs: number): Pulse | null {
        const o = this.#o;
        const w = this.#window(tMs, o.waveWindowMs);
        if (w.length < 6) return null;
        const xs = w.map((s) => s.x);
        const reversals = countReversals(xs, o.waveAmplitude);
        if (reversals < o.waveReversals) return null;
        // A wave stays roughly at one height; a circle or scribble does not.
        const ys = w.map((s) => s.y);
        if (Math.max(...ys) - Math.min(...ys) > 0.2) return null;
        return { signal: "wave", confidence: Math.min(1, 0.6 + 0.1 * (reversals - o.waveReversals)), value: reversals };
    }

    reset(): void {
        this.#buf = [];
        this.#lastSeen = -Infinity;
    }
}
