/**
 * Smoothness metrics for a rendered joint trace sampled on a fixed 60 Hz grid
 * (debug + tests). All in output pixels.
 *
 *  J  = RMS of the 2nd difference p[t+1] - 2p[t] + p[t-1] (px/frame²).
 *       Still subject: residual jitter. Moving subject: acceleration noise.
 *  S  = J on frames right after a new measurement / J on the others.
 *       > 1.5 = visible stepping at the pose rate (piecewise motion).
 *  lag = cross-correlation peak delay (ms) between the rendered trace and the
 *       true motion.
 */

export interface Trace {
    /** Render time per frame (ms). */
    t: number[];
    /** Rendered position per frame (px), one axis. */
    x: number[];
    /** True when a new measurement arrived before this frame was sampled. */
    fresh: boolean[];
}

const rms = (a: number[]): number => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : 0);

export function secondDiff(x: readonly number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < x.length - 1; i++) out.push((x[i + 1] ?? 0) - 2 * (x[i] ?? 0) + (x[i - 1] ?? 0));
    return out;
}

export function jitter(trace: Trace): number {
    return rms(secondDiff(trace.x));
}

export function stepping(trace: Trace): number {
    const d = secondDiff(trace.x);
    const onFresh: number[] = [];
    const other: number[] = [];
    d.forEach((v, i) => ((trace.fresh[i + 1] ?? false) ? onFresh : other).push(v));
    const b = rms(other);
    return b > 1e-9 ? rms(onFresh) / b : 1;
}

/** Delay (ms, >= 0) maximising the correlation of `rendered` against `truth`, both on the same grid. */
export function lagMs(rendered: readonly number[], truth: readonly number[], frameMs: number, maxShift = 30): number {
    const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
    const mr = mean(rendered);
    const mt = mean(truth);
    let best = 0;
    let bestC = -Infinity;
    for (let s = 0; s <= maxShift; s++) {
        let c = 0;
        for (let i = s; i < rendered.length; i++) c += ((rendered[i] ?? 0) - mr) * ((truth[i - s] ?? 0) - mt);
        if (c > bestC) {
            bestC = c;
            best = s;
        }
    }
    return best * frameMs;
}
