/**
 * One-Euro filter (Casiez et al. 2012): low jitter when still, low lag when
 * moving. Used on the MediaPipe shoulder landmarks before a pet is anchored.
 */
export interface OneEuroOptions {
    /** Cutoff at rest, Hz. Lower = smoother, more lag. */
    minCutoff: number;
    /** How fast the cutoff grows with speed. Higher = less lag on motion. */
    beta: number;
    /** Cutoff for the derivative, Hz. */
    dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroOptions = { minCutoff: 1.2, beta: 0.02, dCutoff: 1.0 };

function alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
}

export class OneEuro {
    readonly #o: OneEuroOptions;
    #x: number | null = null;
    #dx = 0;
    #t = 0;

    constructor(options: OneEuroOptions = DEFAULT_ONE_EURO) {
        this.#o = options;
    }

    /** @param tMs sample timestamp in milliseconds (monotonic). */
    filter(value: number, tMs: number): number {
        if (this.#x === null) {
            this.#x = value;
            this.#t = tMs;
            return value;
        }
        const dt = Math.max((tMs - this.#t) / 1000, 1e-3);
        this.#t = tMs;
        const dx = (value - this.#x) / dt;
        this.#dx += alpha(this.#o.dCutoff, dt) * (dx - this.#dx);
        const cutoff = this.#o.minCutoff + this.#o.beta * Math.abs(this.#dx);
        this.#x += alpha(cutoff, dt) * (value - this.#x);
        return this.#x;
    }

    reset(): void {
        this.#x = null;
        this.#dx = 0;
    }
}

/** One filter per axis for a 2D/3D point. */
export class OneEuroPoint {
    readonly #axes: OneEuro[];

    constructor(dims: number, options: OneEuroOptions = DEFAULT_ONE_EURO) {
        this.#axes = Array.from({ length: dims }, () => new OneEuro(options));
    }

    filter(point: readonly number[], tMs: number): number[] {
        return point.map((v, i) => this.#axes[i]?.filter(v, tMs) ?? v);
    }

    reset(): void {
        for (const a of this.#axes) a.reset();
    }
}
