/**
 * PCM16 helpers shared by the speaker (decode) and the microphone worklet
 * (resample + encode). Pure functions so they can run inside an
 * AudioWorkletGlobalScope, where there is no DOM.
 */

const INT16_SCALE = 32_768;

export interface Pcm16Decoder {
    /** Decode one base64 chunk of PCM16LE mono into [-1, 1] floats. */
    decode(base64: string): Float32Array<ArrayBuffer>;
}

/**
 * A streaming decoder. Chunk boundaries are arbitrary byte boundaries, so an
 * odd trailing byte is carried into the next chunk instead of being dropped
 * (dropping it would shift every following sample by one byte — loud noise).
 */
export function createPcm16Decoder(): Pcm16Decoder {
    let carry: number | null = null;
    return {
        decode(base64) {
            const binary = atob(base64);
            const offset = carry === null ? 0 : 1;
            const total = binary.length + offset;
            const bytes = new Uint8Array(total);
            if (carry !== null) bytes[0] = carry;
            for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);

            const samples = Math.floor(total / 2);
            carry = total % 2 === 1 ? (bytes[total - 1] ?? 0) : null;

            const out = new Float32Array(samples);
            const view = new DataView(bytes.buffer, 0, samples * 2);
            for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / INT16_SCALE;
            return out;
        },
    };
}

/** Clamp floats to PCM16. */
export function floatToPcm16(input: Float32Array): Int16Array<ArrayBuffer> {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i] ?? 0));
        out[i] = s < 0 ? Math.round(s * INT16_SCALE) : Math.round(s * (INT16_SCALE - 1));
    }
    return out;
}

/** Base64 without blowing the argument limit of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
        binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return btoa(binary);
}

/** Root-mean-square level of a block, 0..1. */
export function rmsOf(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i] ?? 0;
        sum += s * s;
    }
    return Math.sqrt(sum / samples.length);
}

/**
 * Streaming linear-interpolation resampler.
 *
 * Keeps the fractional read position and the last input sample across
 * blocks, so 128-frame worklet quanta resample seamlessly.
 */
export class StreamResampler {
    readonly #ratio: number;
    /** Next output position in the coordinates of the current block; -1 = previous sample. */
    #pos = 0;
    #prev = 0;

    constructor(fromRate: number, toRate: number) {
        this.#ratio = fromRate / toRate;
    }

    push(input: Float32Array): Float32Array<ArrayBuffer> {
        const n = input.length;
        if (n === 0) return new Float32Array(0);
        const out = new Float32Array(Math.ceil((n - this.#pos) / this.#ratio) + 1);
        let count = 0;
        let pos = this.#pos;
        while (pos <= n - 1) {
            const i = Math.floor(pos);
            const frac = pos - i;
            const a = i < 0 ? this.#prev : (input[i] ?? 0);
            const b = input[i + 1] ?? a;
            out[count++] = a + (b - a) * frac;
            pos += this.#ratio;
        }
        this.#pos = pos - n;
        this.#prev = input[n - 1] ?? 0;
        return out.subarray(0, count);
    }
}
