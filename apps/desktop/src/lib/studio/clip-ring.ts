/* ------------------------------------------------------------------ *
 * Rolling buffer of encoded H.264 access units (WS28-07, decision Q50).
 * Pure: no WebCodecs, so the trimming rules are unit-tested.
 * ------------------------------------------------------------------ */

export interface ClipChunk {
    data: Uint8Array;
    key: boolean;
    /** Microseconds (WebCodecs timestamps). */
    ts: number;
    dur: number;
}

/**
 * Keeps at least `windowUs` of video that starts on a keyframe, so a save is
 * always decodable from its first frame. With a keyframe every second the kept
 * span is `windowUs` .. `windowUs + 1 s`. `maxBytes` is a hard RAM cap: past
 * it, whole GOPs are dropped from the front even if the window shrinks.
 */
export class ClipRing {
    #chunks: ClipChunk[] = [];
    #bytes = 0;
    windowUs: number;
    maxBytes: number;

    constructor(windowUs: number, maxBytes: number) {
        this.windowUs = windowUs;
        this.maxBytes = maxBytes;
    }

    get bytes(): number {
        return this.#bytes;
    }

    get length(): number {
        return this.#chunks.length;
    }

    /** Span from the first chunk's start to the last chunk's end, µs. */
    get durationUs(): number {
        const first = this.#chunks[0];
        const last = this.#chunks.at(-1);
        return first && last ? last.ts + last.dur - first.ts : 0;
    }

    /** Returns false when the chunk was refused (a delta with no keyframe before it). */
    push(chunk: ClipChunk): boolean {
        if (this.#chunks.length === 0 && !chunk.key) return false;
        this.#chunks.push(chunk);
        this.#bytes += chunk.data.byteLength;
        this.#trim();
        return true;
    }

    /** Immutable view for muxing; chunks are never mutated after push. */
    snapshot(): readonly ClipChunk[] {
        return this.#chunks.slice();
    }

    clear(): void {
        this.#chunks = [];
        this.#bytes = 0;
    }

    #trim(): void {
        const chunks = this.#chunks;
        const last = chunks.at(-1);
        if (!last) return;
        const end = last.ts + last.dur;
        // Latest keyframe that still leaves a full window behind the newest frame.
        let cut = 0;
        for (let i = 1; i < chunks.length; i++) {
            const c = chunks[i];
            if (!c?.key) continue;
            if (end - c.ts >= this.windowUs) cut = i;
            else break;
        }
        let dropped = 0;
        for (let i = 0; i < cut; i++) dropped += chunks[i]?.data.byteLength ?? 0;
        // RAM cap: drop whole GOPs until under budget (never the last GOP).
        while (this.#bytes - dropped > this.maxBytes) {
            let next = -1;
            for (let i = cut + 1; i < chunks.length; i++) {
                if (chunks[i]?.key) {
                    next = i;
                    break;
                }
            }
            if (next < 0) break;
            for (let i = cut; i < next; i++) dropped += chunks[i]?.data.byteLength ?? 0;
            cut = next;
        }
        if (cut > 0) {
            this.#chunks = chunks.slice(cut);
            this.#bytes -= dropped;
        }
    }
}

/** `TikSee-20261006-041530.mp4` in local time. */
export function clipFileName(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `TikSee-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}

/** RAM cap for a buffer: bitrate × (window + 2 s) with 50 % headroom for keyframe spikes. */
export function clipByteBudget(bitrateMbps: number, seconds: number): number {
    return Math.round(((bitrateMbps * 1_000_000) / 8) * (seconds + 2) * 1.5);
}
