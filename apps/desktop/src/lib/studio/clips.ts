import type { ClipSettings } from "@tiksee/core";
import type * as THREE from "three/webgpu";

import { ClipRing, clipByteBudget, type ClipChunk } from "./clip-ring.js";

/**
 * Rolling clip buffer of the OUTPUT render target (WS28-07, decision Q50).
 *
 * GPU path, no pixel readback: the output texture is copied on the GPU into
 * an OffscreenCanvas owned by the same WebGPU device, turned into a
 * `VideoFrame` (GPU-backed ImageBitmap), and encoded by a hardware H.264
 * `VideoEncoder`. Encoded access units go into a byte-capped `ClipRing`, so
 * RAM ≈ bitrate × window (8 Mbps × 30 s ≈ 30 MB). Capture runs at 30 fps
 * with a keyframe every second; it never blocks the render loop (a full
 * encoder queue drops the frame).
 */

const CLIP_FPS = 30;
const KEY_EVERY = CLIP_FPS;
/** Frames waiting in the encoder before new ones are dropped. */
const MAX_QUEUE = 3;
/** GPUTextureUsage.COPY_DST | RENDER_ATTACHMENT (WebGPU spec §6.1). */
const CANVAS_USAGE = 0x02 | 0x10;

/**
 * High profile. Level 4.0 allows 8192 macroblocks per frame (1080×1920 = 8160
 * at 30 fps); a larger negotiated output needs level 5.1.
 */
export function clipCodec(width: number, height: number): string {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    return mbs <= 8192 ? "avc1.640028" : "avc1.640033";
}

export type ClipState = "off" | "starting" | "recording" | "unsupported" | "error";

export interface ClipTimings {
    /** CPU ms per captured frame: GPU copy submit + VideoFrame + encode() call. */
    clipCapture: number;
    clipFps: number;
    clipQueue: number;
    clipDropped: number;
    /** Buffered seconds and MB (for the HUD / ?bench). */
    clipSeconds: number;
    clipMB: number;
}

export interface SavedClip {
    name: string;
    bytes: ArrayBuffer;
    seconds: number;
}

interface BackendInternals {
    device?: GPUDevice;
    get(o: object): { texture?: GPUTexture };
}

const ema = (prev: number, v: number): number => (prev === 0 ? v : prev * 0.9 + v * 0.1);

export class ClipRecorder {
    readonly timings: ClipTimings = { clipCapture: 0, clipFps: 0, clipQueue: 0, clipDropped: 0, clipSeconds: 0, clipMB: 0 };
    readonly #renderer: THREE.WebGPURenderer;
    readonly #onError: (m: string) => void;
    readonly #ring = new ClipRing(30_000_000, clipByteBudget(8, 30));
    #settings: ClipSettings | null = null;
    #state: ClipState = "off";
    #encoder: VideoEncoder | null = null;
    #decoderConfig: VideoDecoderConfig | null = null;
    #canvas: OffscreenCanvas | null = null;
    #ctx: GPUCanvasContext | null = null;
    #size = { w: 0, h: 0 };
    #frameNo = 0;
    #lastCapture = 0;
    #t0 = 0;
    #fpsWindow = 0;
    #captured = 0;
    #configuring = false;

    constructor(renderer: THREE.WebGPURenderer, onError: (m: string) => void) {
        this.#renderer = renderer;
        this.#onError = onError;
    }

    get state(): ClipState {
        return this.#state;
    }

    configure(settings: ClipSettings): void {
        const prev = this.#settings;
        this.#settings = settings;
        this.#ring.windowUs = settings.seconds * 1_000_000;
        this.#ring.maxBytes = clipByteBudget(settings.bitrateMbps, settings.seconds);
        if (!settings.enabled) {
            this.#close();
            this.#state = "off";
            return;
        }
        // A bitrate change needs a new encoder; the old GOPs stay valid.
        if (prev && prev.bitrateMbps !== settings.bitrateMbps && this.#encoder) this.#closeEncoder();
        if (this.#state === "off") this.#state = "starting";
    }

    /** Call after the output RT is rendered. `now` = rAF time. */
    frame(target: THREE.RenderTarget, now: number): void {
        const s = this.#settings;
        if (!s?.enabled || this.#state === "error") return;
        if (this.#state === "unsupported" && target.width === this.#size.w && target.height === this.#size.h) return;
        if (now - this.#lastCapture < 1000 / CLIP_FPS - 2) return;
        this.#lastCapture = now;
        if (now - this.#fpsWindow >= 1000) {
            this.timings.clipFps = (this.#captured * 1000) / Math.max(now - this.#fpsWindow, 1);
            this.#captured = 0;
            this.#fpsWindow = now;
            this.timings.clipSeconds = this.#ring.durationUs / 1e6;
            this.timings.clipMB = this.#ring.bytes / 1_048_576;
        }
        const w = target.width;
        const h = target.height;
        if (w % 2 !== 0 || h % 2 !== 0) return;
        if (w !== this.#size.w || h !== this.#size.h) {
            // New geometry: old GOPs cannot be muxed with the new SPS.
            this.#closeEncoder();
            this.#ring.clear();
            this.#size = { w, h };
            if (this.#state === "unsupported") this.#state = "starting";
        }
        if (!this.#encoder) {
            this.#startEncoder(w, h, s.bitrateMbps);
            return;
        }
        if (this.#encoder.state !== "configured") return;
        if (this.#encoder.encodeQueueSize >= MAX_QUEUE) {
            this.timings.clipDropped++;
            return;
        }
        this.#capture(target, w, h, now);
    }

    #backend(): BackendInternals {
        return this.#renderer.backend as unknown as BackendInternals;
    }

    #startEncoder(w: number, h: number, bitrateMbps: number): void {
        if (this.#configuring) return;
        if (typeof VideoEncoder === "undefined" || typeof OffscreenCanvas === "undefined") {
            this.#state = "unsupported";
            return;
        }
        const device = this.#backend().device;
        if (!device) {
            this.#state = "unsupported";
            return;
        }
        const config: VideoEncoderConfig = {
            codec: clipCodec(w, h),
            width: w,
            height: h,
            bitrate: bitrateMbps * 1_000_000,
            framerate: CLIP_FPS,
            hardwareAcceleration: "prefer-hardware",
            latencyMode: "realtime",
            avc: { format: "avc" },
        };
        this.#configuring = true;
        void VideoEncoder.isConfigSupported(config)
            .then((support) => {
                this.#configuring = false;
                if (!support.supported || this.#settings?.enabled !== true || this.#size.w !== w || this.#size.h !== h) {
                    if (!support.supported) this.#state = "unsupported";
                    return;
                }
                const canvas = new OffscreenCanvas(w, h);
                // TS DOM lib types OffscreenCanvas.getContext("webgpu") as the generic union.
                const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
                if (!ctx) {
                    this.#state = "unsupported";
                    return;
                }
                // rgba8unorm is copy-compatible with the sRGB output target: the
                // stored (encoded) bytes are copied as-is, which is what a viewer sees.
                ctx.configure({ device, format: "rgba8unorm", usage: CANVAS_USAGE, alphaMode: "opaque" });
                const encoder = new VideoEncoder({
                    output: (chunk, meta) => this.#onChunk(chunk, meta),
                    error: (e) => {
                        this.#state = "error";
                        this.#onError(`clip encoder: ${String(e)}`);
                    },
                });
                encoder.configure(config);
                this.#canvas = canvas;
                this.#ctx = ctx;
                this.#encoder = encoder;
                this.#frameNo = 0;
                this.#t0 = performance.now();
                this.#state = "recording";
            })
            .catch((e: unknown) => {
                this.#configuring = false;
                this.#state = "error";
                this.#onError(`clip encoder: ${String(e)}`);
            });
    }

    #capture(target: THREE.RenderTarget, w: number, h: number, now: number): void {
        const device = this.#backend().device;
        const tex = this.#backend().get(target.texture).texture;
        const ctx = this.#ctx;
        const canvas = this.#canvas;
        const encoder = this.#encoder;
        if (!device || !tex || !ctx || !canvas || !encoder) return;
        const t0 = performance.now();
        const enc = device.createCommandEncoder({ label: "tiksee clip" });
        enc.copyTextureToTexture({ texture: tex }, { texture: ctx.getCurrentTexture() }, [w, h, 1]);
        device.queue.submit([enc.finish()]);
        const bitmap = canvas.transferToImageBitmap();
        const frame = new VideoFrame(bitmap, { timestamp: Math.round((now - this.#t0) * 1000), duration: Math.round(1e6 / CLIP_FPS) });
        bitmap.close();
        encoder.encode(frame, { keyFrame: this.#frameNo % KEY_EVERY === 0 });
        frame.close();
        this.#frameNo++;
        this.#captured++;
        this.timings.clipQueue = encoder.encodeQueueSize;
        this.timings.clipCapture = ema(this.timings.clipCapture, performance.now() - t0);
    }

    #onChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
        if (meta?.decoderConfig) this.#decoderConfig = meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const c: ClipChunk = { data, key: chunk.type === "key", ts: chunk.timestamp, dur: chunk.duration ?? Math.round(1e6 / CLIP_FPS) };
        this.#ring.push(c);
    }

    /** Mux the buffered window into an MP4. Flushes the encoder first so the newest frames are included. */
    async save(name: string): Promise<SavedClip> {
        const encoder = this.#encoder;
        if (this.#state === "unsupported") throw new Error("H.264 encoding is not available on this GPU/WebView");
        if (!encoder || this.#state !== "recording") throw new Error("the clip buffer is not recording");
        await encoder.flush();
        const chunks = this.#ring.snapshot();
        const config = this.#decoderConfig;
        if (chunks.length === 0 || !config) throw new Error("the clip buffer is still empty");
        const { muxClip } = await import("./clip-mux.js");
        const bytes = await muxClip(chunks, config);
        const first = chunks[0];
        const last = chunks.at(-1);
        const seconds = first && last ? (last.ts + last.dur - first.ts) / 1e6 : 0;
        return { name, bytes, seconds };
    }

    #closeEncoder(): void {
        if (this.#encoder && this.#encoder.state !== "closed") this.#encoder.close();
        this.#encoder = null;
        this.#decoderConfig = null;
        this.#ctx?.unconfigure();
        this.#ctx = null;
        this.#canvas = null;
        if (this.#state === "recording") this.#state = "starting";
    }

    #close(): void {
        this.#closeEncoder();
        this.#ring.clear();
        this.#size = { w: 0, h: 0 };
        this.timings.clipSeconds = 0;
        this.timings.clipMB = 0;
    }

    dispose(): void {
        this.#close();
        this.#state = "off";
    }
}
