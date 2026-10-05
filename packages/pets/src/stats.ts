/** Rolling frame statistics for the 1080p60 budget (WS23-05). */
export interface FrameStatsSnapshot {
    fps: number;
    /** Mean CPU time spent inside the frame callback, ms. */
    workMs: number;
    /** 95th-percentile interval between frames, ms. */
    p95IntervalMs: number;
    frames: number;
}

export class FrameStats {
    readonly #intervals: number[] = [];
    readonly #work: number[] = [];
    readonly #size: number;
    #last: number | null = null;
    #frames = 0;

    constructor(windowFrames = 120) {
        this.#size = windowFrames;
    }

    /** Call once per presented frame with the frame timestamp and the work it took. */
    record(nowMs: number, workMs: number): void {
        if (this.#last !== null) push(this.#intervals, nowMs - this.#last, this.#size);
        push(this.#work, workMs, this.#size);
        this.#last = nowMs;
        this.#frames++;
    }

    snapshot(): FrameStatsSnapshot {
        const sum = this.#intervals.reduce((a, b) => a + b, 0);
        const sorted = [...this.#intervals].sort((a, b) => a - b);
        const p95 = sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0) : 0;
        const work = this.#work.length ? this.#work.reduce((a, b) => a + b, 0) / this.#work.length : 0;
        return {
            fps: sum > 0 ? (this.#intervals.length * 1000) / sum : 0,
            workMs: work,
            p95IntervalMs: p95,
            frames: this.#frames,
        };
    }

    reset(): void {
        this.#intervals.length = 0;
        this.#work.length = 0;
        this.#last = null;
        this.#frames = 0;
    }
}

function push(list: number[], value: number, max: number): void {
    list.push(value);
    if (list.length > max) list.shift();
}
