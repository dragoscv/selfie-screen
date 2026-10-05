export interface VadOptions {
    /** Speech must exceed the noise floor by this factor. */
    ratio: number;
    /** Absolute RMS below which nothing counts as speech. */
    minLevel: number;
    /** Keep "speaking" this long after the last loud block (bridges word gaps). */
    hangoverMs: number;
}

const DEFAULTS: VadOptions = { ratio: 3, minLevel: 0.012, hangoverMs: 350 };

/**
 * Energy VAD with an adaptive noise floor. Deliberately simple: it only has
 * to decide when to stream audio, duck the co-host and commit a turn — the
 * transcription model does the real work.
 */
export class EnergyVad {
    readonly #options: VadOptions;
    #floor = 0.004;
    #speaking = false;
    #lastVoiceAt = Number.NEGATIVE_INFINITY;

    constructor(options: Partial<VadOptions> = {}) {
        this.#options = { ...DEFAULTS, ...options };
    }

    get speaking(): boolean {
        return this.#speaking;
    }

    get lastVoiceAt(): number {
        return this.#lastVoiceAt;
    }

    /** Feed one block level (RMS 0..1) at time `now` (ms); returns the speaking state. */
    update(level: number, now: number): boolean {
        const threshold = Math.max(this.#options.minLevel, this.#floor * this.#options.ratio);
        if (level > threshold) {
            this.#lastVoiceAt = now;
            this.#speaking = true;
        } else {
            // Only quiet blocks teach the floor, or loud speech would raise it.
            this.#floor = this.#floor * 0.95 + level * 0.05;
            if (now - this.#lastVoiceAt > this.#options.hangoverMs) this.#speaking = false;
        }
        return this.#speaking;
    }
}
