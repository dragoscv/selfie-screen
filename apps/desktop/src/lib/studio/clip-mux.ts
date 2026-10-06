/**
 * Lazy chunk: MP4 muxing of a clip-ring snapshot with mediabunny (MPL-2.0,
 * unmodified). Loaded on the first save so the studio entry stays small.
 */
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny";

import type { ClipChunk } from "./clip-ring.js";

export async function muxClip(chunks: readonly ClipChunk[], decoderConfig: VideoDecoderConfig): Promise<ArrayBuffer> {
    const first = chunks[0];
    if (!first) throw new Error("clip buffer is empty");
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const source = new EncodedVideoPacketSource("avc");
    output.addVideoTrack(source);
    await output.start();
    const t0 = first.ts;
    for (const [i, c] of chunks.entries()) {
        const packet = new EncodedPacket(c.data, c.key ? "key" : "delta", (c.ts - t0) / 1e6, c.dur / 1e6);
        await source.add(packet, i === 0 ? { decoderConfig } : undefined);
    }
    await output.finalize();
    const buf = output.target.buffer;
    if (!buf) throw new Error("mp4 muxer produced no data");
    return buf;
}
