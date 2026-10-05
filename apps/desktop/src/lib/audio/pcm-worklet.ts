/**
 * AudioWorklet: microphone → mono → 24 kHz PCM16 frames (+ RMS level).
 *
 * Loaded through Vite's `?worker&url` so it is bundled as its own same-origin
 * module — the CSP allows `script-src 'self'` but not `blob:`.
 */
import { StreamResampler, floatToPcm16, rmsOf } from "./pcm.js";

// The AudioWorkletGlobalScope is not part of the DOM lib.
interface AudioWorkletProcessorShape {
    readonly port: MessagePort;
}
declare const AudioWorkletProcessor: {
    prototype: AudioWorkletProcessorShape;
    new(): AudioWorkletProcessorShape;
};
declare const sampleRate: number;
declare function registerProcessor(
    name: string,
    processor: new () => AudioWorkletProcessorShape & {
        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    },
): void;

const TARGET_RATE = 24_000;
/** 40 ms frames: small enough for low latency, large enough to keep postMessage cheap. */
const FRAME_SAMPLES = 960;

class PcmCaptureProcessor extends AudioWorkletProcessor {
    readonly #resampler = new StreamResampler(sampleRate, TARGET_RATE);
    readonly #frame = new Float32Array(FRAME_SAMPLES);
    #filled = 0;

    process(inputs: Float32Array[][]): boolean {
        const channels = inputs[0];
        const first = channels?.[0];
        if (!channels || !first) return true;

        let mono: Float32Array = first;
        if (channels.length > 1) {
            mono = new Float32Array(first.length);
            for (const channel of channels) {
                for (let i = 0; i < channel.length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
            }
        }

        const resampled = this.#resampler.push(mono);
        let offset = 0;
        while (offset < resampled.length) {
            const take = Math.min(FRAME_SAMPLES - this.#filled, resampled.length - offset);
            this.#frame.set(resampled.subarray(offset, offset + take), this.#filled);
            this.#filled += take;
            offset += take;
            if (this.#filled === FRAME_SAMPLES) {
                const pcm = floatToPcm16(this.#frame);
                this.port.postMessage({ level: rmsOf(this.#frame), pcm: pcm.buffer }, [pcm.buffer]);
                this.#filled = 0;
            }
        }
        return true;
    }
}

registerProcessor("tiksee-pcm-capture", PcmCaptureProcessor);
