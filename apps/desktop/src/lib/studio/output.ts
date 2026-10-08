import { invoke, isTauri } from "@tauri-apps/api/core";
import type * as THREE from "three/webgpu";

/* ------------------------------------------------------------------ *
 * RGBA -> NV12, BT.709 limited range. Mirrors
 * src-tauri/vcam/shared/src/nv12.rs exactly (8.8 fixed point, 2x2 averaged
 * chroma, chroma clamped 16..240).
 * ------------------------------------------------------------------ */

export function nv12Length(width: number, height: number): number {
    return width * height + width * (height >> 1);
}

const luma = (r: number, g: number, b: number): number => ((47 * r + 157 * g + 16 * b + 128) >> 8) + 16;
const chromaU = (r: number, g: number, b: number): number => Math.min(Math.max(((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128, 16), 240);
const chromaV = (r: number, g: number, b: number): number => Math.min(Math.max(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128, 16), 240);

/** One colour as limited-range BT.709 (Y, U, V). */
export function yuv(r: number, g: number, b: number): [number, number, number] {
    return [luma(r, g, b), chromaU(r, g, b), chromaV(r, g, b)];
}

/**
 * CPU reference / fallback. `stride` = bytes per RGBA row (readbacks pad rows
 * to 256 bytes). Width must be even and height even.
 */
export function rgbaToNv12(rgba: Uint8Array, width: number, height: number, out: Uint8Array, stride = width * 4): void {
    const uvBase = width * height;
    for (let y = 0; y < height; y += 2) {
        const top = y * stride;
        const bottom = top + stride;
        const uvRow = uvBase + (y >> 1) * width;
        for (let x = 0; x < width; x += 2) {
            let sr = 0;
            let sg = 0;
            let sb = 0;
            for (let dy = 0; dy < 2; dy++) {
                const row = dy === 0 ? top : bottom;
                for (let dx = 0; dx < 2; dx++) {
                    const p = row + (x + dx) * 4;
                    const r = rgba[p] ?? 0;
                    const g = rgba[p + 1] ?? 0;
                    const b = rgba[p + 2] ?? 0;
                    out[(y + dy) * width + x + dx] = luma(r, g, b);
                    sr += r;
                    sg += g;
                    sb += b;
                }
            }
            const r = (sr + 2) >> 2;
            const g = (sg + 2) >> 2;
            const b = (sb + 2) >> 2;
            out[uvRow + x] = chromaU(r, g, b);
            out[uvRow + x + 1] = chromaV(r, g, b);
        }
    }
}

/**
 * GPU version: one invocation per 4x2 pixel block writes one u32 of each Y
 * row and one u32 (two UV pairs) of the chroma plane. The source is an sRGB
 * render target, so textureLoad returns linear values; re-encode before the
 * fixed-point maths so the bytes match what a readback would see.
 */
export const NV12_WGSL = /* wgsl */ `
struct Params { width: u32, height: u32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;

fn enc(c: vec3f) -> vec3i {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    let s = select(hi, lo, c <= vec3f(0.0031308));
    return vec3i(round(clamp(s, vec3f(0.0), vec3f(1.0)) * 255.0));
}
fn lumaOf(c: vec3i) -> u32 { return u32(((47 * c.r + 157 * c.g + 16 * c.b + 128) >> 8u) + 16); }
fn uOf(c: vec3i) -> u32 { return u32(clamp(((-26 * c.r - 86 * c.g + 112 * c.b + 128) >> 8u) + 128, 16, 240)); }
fn vOf(c: vec3i) -> u32 { return u32(clamp(((112 * c.r - 102 * c.g - 10 * c.b + 128) >> 8u) + 128, 16, 240)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let x = id.x * 4u;
    let y = id.y * 2u;
    if (x >= p.width || y >= p.height) { return; }
    var y0 = 0u;
    var y1 = 0u;
    var uv = 0u;
    for (var k = 0u; k < 2u; k++) {
        let a = enc(textureLoad(src, vec2u(x + 2u * k, y), 0).rgb);
        let b = enc(textureLoad(src, vec2u(x + 2u * k + 1u, y), 0).rgb);
        let c = enc(textureLoad(src, vec2u(x + 2u * k, y + 1u), 0).rgb);
        let d = enc(textureLoad(src, vec2u(x + 2u * k + 1u, y + 1u), 0).rgb);
        y0 |= (lumaOf(a) | (lumaOf(b) << 8u)) << (16u * k);
        y1 |= (lumaOf(c) | (lumaOf(d) << 8u)) << (16u * k);
        let m = (a + b + c + d + vec3i(2)) >> vec3u(2u);
        uv |= (uOf(m) | (vOf(m) << 8u)) << (16u * k);
    }
    let w4 = p.width / 4u;
    dst[y * w4 + id.x] = y0;
    dst[(y + 1u) * w4 + id.x] = y1;
    dst[(p.width * p.height) / 4u + id.y * w4 + id.x] = uv;
}
`;

/* ------------------------------------------------------------------ *
 * Virtual camera pump.
 * ------------------------------------------------------------------ */

export type VcamState = "off" | "waiting" | "streaming" | "unregistered" | "error";

/** What `vcam_status` returns (lenient: the Rust side may send the consumer as an object or a tuple). */
export interface VcamStatusWire {
    state?: string;
    fps?: number;
    consumer?: { width: number; height: number; fps?: number } | [number, number, number?] | null;
}

export function parseVcamStatus(s: VcamStatusWire | null | undefined): { state: VcamState; fps: number; consumerSize?: [number, number] } {
    const known: VcamState[] = ["off", "waiting", "streaming", "unregistered", "error"];
    const state = known.includes(s?.state as VcamState) ? (s?.state as VcamState) : s ? "waiting" : "off";
    const c = s?.consumer;
    const size: [number, number] | undefined = Array.isArray(c) ? [c[0], c[1]] : c ? [c.width, c.height] : undefined;
    return { state, fps: s?.fps ?? 0, ...(size && size[0] > 0 && size[1] > 0 ? { consumerSize: size } : {}) };
}

export interface PumpTimings {
    /** CPU time to encode + submit the compute pass (GPU path) or the CPU conversion (fallback), ms. */
    vcamConvert: number;
    /** Submit -> mapped (GPU) or readRenderTargetPixelsAsync latency (fallback), ms. */
    vcamReadback: number;
    vcamIpc: number;
    /** Frames actually delivered per second. */
    vcamFps: number;
    vcamDropped: number;
    /** Drops by cause: no free GPU staging buffer / socket backed up / invoke still busy. */
    vcamDropSlot: number;
    vcamDropWs: number;
    vcamDropIpc: number;
}

interface BackendInternals {
    device?: GPUDevice;
    get(o: object): { texture?: GPUTexture };
}

/**
 * WebGPU flag values (GPUBufferUsage / GPUMapMode namespaces, WebGPU spec
 * §5.1 and §5.2). `@webgpu/types` is not installed, so the globals are not
 * declared; the numbers are fixed by the spec.
 */
export const BUFFER_USAGE = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
} as const;
export const MAP_MODE = { READ: 0x0001, WRITE: 0x0002 } as const;

const ema = (prev: number, v: number): number => (prev === 0 ? v : prev * 0.9 + v * 0.1);

/**
 * Converts the OUTPUT render target to NV12 every output frame and ships it
 * to Rust over raw IPC. Never blocks the frame: a busy readback slot or a
 * pending IPC call drops the frame.
 */
export class VcamPump {
    readonly timings: PumpTimings = { vcamConvert: 0, vcamReadback: 0, vcamIpc: 0, vcamFps: 0, vcamDropped: 0, vcamDropSlot: 0, vcamDropWs: 0, vcamDropIpc: 0 };
    readonly #renderer: THREE.WebGPURenderer;
    readonly #onError: (m: string) => void;
    readonly #ipc: boolean;
    #gpu: {
        device: GPUDevice;
        pipeline: GPUComputePipeline;
        params: GPUBuffer;
        out: GPUBuffer | null;
        staging: { buf: GPUBuffer; busy: boolean }[];
        bind: GPUBindGroup | null;
        boundTex: GPUTexture | null;
        boundOut: GPUBuffer | null;
    } | null = null;
    #size = { w: 0, h: 0 };
    #frames: Uint8Array[] = [];
    #frameSlot = 0;
    #ipcBusy = false;
    #cpuBusy = false;
    #lastPump = 0;
    #delivered = 0;
    #fpsWindow = 0;
    #enabled = false;
    #fps: 30 | 60 = 60;
    #status: ReturnType<typeof parseVcamStatus> = { state: "off", fps: 0 };
    #poll: ReturnType<typeof setInterval> | null = null;
    #configured = "";
    /** Loopback frame socket (Rust `vcam_endpoint`); raw IPC is ~200 ms per 3 MB frame. */
    #ws: WebSocket | null = null;
    #wsConnecting = false;
    #wsRetryAt = 0;
    /** Force the readRenderTargetPixelsAsync + CPU path (for A/B measurement). */
    forceCpu = false;

    constructor(renderer: THREE.WebGPURenderer, onError: (m: string) => void, options: { measureOnly?: boolean } = {}) {
        this.#renderer = renderer;
        this.#onError = onError;
        this.#ipc = isTauri() && !options.measureOnly;
    }

    get status(): ReturnType<typeof parseVcamStatus> {
        return this.#enabled ? this.#status : { state: "off", fps: 0 };
    }

    /** Enable/disable and tell Rust the format (orientation + fps); polls status every second while enabled. */
    configure(enabled: boolean, portrait: boolean, fps: 30 | 60, measure = false): void {
        this.#enabled = enabled || measure;
        this.#fps = fps;
        if (!this.#ipc) return;
        if (enabled && !this.#poll) {
            this.#poll = setInterval(() => {
                invoke<VcamStatusWire>("vcam_status")
                    .then((s) => {
                        this.#status = parseVcamStatus(s);
                    })
                    .catch(() => {
                        this.#status = { state: "error", fps: 0 };
                    });
            }, 1000);
        } else if (!enabled && this.#poll) {
            clearInterval(this.#poll);
            this.#poll = null;
            this.#status = { state: "off", fps: 0 };
        }
        const key = `${String(enabled)}:${String(portrait)}:${fps}`;
        if (enabled && key !== this.#configured) {
            this.#configured = key;
            invoke("vcam_configure", { portrait, fps }).catch((e: unknown) => this.#onError(`vcam_configure: ${String(e)}`));
        }
    }

    #backend(): BackendInternals {
        return this.#renderer.backend as unknown as BackendInternals;
    }

    #initGpu(): boolean {
        if (this.#gpu) return true;
        const device = this.#backend().device;
        if (!device) return false;
        const module = device.createShaderModule({ code: NV12_WGSL, label: "tiksee nv12" });
        const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" }, label: "tiksee nv12" });
        const params = device.createBuffer({ size: 16, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
        this.#gpu = { device, pipeline, params, out: null, staging: [], bind: null, boundTex: null, boundOut: null };
        return true;
    }

    #resize(w: number, h: number): void {
        if (this.#size.w === w && this.#size.h === h) return;
        this.#size = { w, h };
        const bytes = nv12Length(w, h);
        this.#frames = [new Uint8Array(bytes), new Uint8Array(bytes)];
        const g = this.#gpu;
        if (!g) return;
        g.out?.destroy();
        for (const s of g.staging) if (!s.busy) s.buf.destroy();
        g.out = g.device.createBuffer({ size: bytes, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC });
        // mapAsync resolves only after the whole frame's GPU work (measured 64-80 ms
        // under load), so keep several readbacks in flight instead of one.
        g.staging = [0, 1, 2, 3].map(() => ({ buf: g.device.createBuffer({ size: bytes, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST }), busy: false }));
        g.device.queue.writeBuffer(g.params, 0, new Uint32Array([w, h, 0, 0]));
        g.bind = null;
    }

    /** Call after the output RT is rendered. `now` = rAF time. */
    frame(target: THREE.RenderTarget, now: number): void {
        if (!this.#enabled) return;
        if (now - this.#lastPump < 1000 / this.#fps - 2) return;
        this.#lastPump = now;
        if (now - this.#fpsWindow >= 1000) {
            this.timings.vcamFps = (this.#delivered * 1000) / Math.max(now - this.#fpsWindow, 1);
            this.#delivered = 0;
            this.#fpsWindow = now;
        }
        const w = target.width;
        const h = target.height;
        if (w % 4 !== 0 || h % 2 !== 0) return;
        if (!this.forceCpu && this.#initGpu()) this.#gpuFrame(target, w, h);
        else this.#cpuFrame(target, w, h);
    }

    #gpuFrame(target: THREE.RenderTarget, w: number, h: number): void {
        const g = this.#gpu;
        if (!g) return;
        this.#resize(w, h);
        const tex = this.#backend().get(target.texture).texture;
        // Skip only when every staging buffer is in flight (never block the frame).
        const slot = g.staging.find((s) => !s.busy);
        if (!tex || !g.out || !slot) {
            this.timings.vcamDropped++;
            this.timings.vcamDropSlot++;
            return;
        }
        const t0 = performance.now();
        if (g.bind === null || g.boundTex !== tex || g.boundOut !== g.out) {
            g.bind = g.device.createBindGroup({
                layout: g.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: tex.createView() },
                    { binding: 1, resource: { buffer: g.out } },
                    { binding: 2, resource: { buffer: g.params } },
                ],
            });
            g.boundTex = tex;
            g.boundOut = g.out;
        }
        const enc = g.device.createCommandEncoder({ label: "tiksee nv12" });
        const pass = enc.beginComputePass();
        pass.setPipeline(g.pipeline);
        pass.setBindGroup(0, g.bind);
        pass.dispatchWorkgroups(Math.ceil(w / 4 / 8), Math.ceil(h / 2 / 8));
        pass.end();
        enc.copyBufferToBuffer(g.out, 0, slot.buf, 0, nv12Length(w, h));
        g.device.queue.submit([enc.finish()]);
        const t1 = performance.now();
        this.timings.vcamConvert = ema(this.timings.vcamConvert, t1 - t0);
        slot.busy = true;
        const buf = slot.buf;
        buf.mapAsync(MAP_MODE.READ)
            .then(() => {
                this.timings.vcamReadback = ema(this.timings.vcamReadback, performance.now() - t1);
                if (this.#size.w !== w || this.#size.h !== h) {
                    buf.unmap();
                    buf.destroy();
                    return;
                }
                const mapped = new Uint8Array(buf.getMappedRange());
                // Socket path: copy the mapped range straight into the wire buffer (one 3 MB copy
                // per frame instead of two); otherwise into the frame pool for invoke.
                if (this.#socketReady(mapped.byteLength)) {
                    const t2 = performance.now();
                    const msg = this.#wire(mapped, w, h);
                    buf.unmap();
                    slot.busy = false;
                    this.#ws?.send(msg);
                    this.#delivered++;
                    this.timings.vcamIpc = ema(this.timings.vcamIpc, performance.now() - t2);
                    return;
                }
                const frame = this.#nextFrame();
                frame.set(mapped);
                buf.unmap();
                slot.busy = false;
                this.#send(frame, w, h);
            })
            .catch((e: unknown) => {
                slot.busy = false;
                this.#onError(`vcam readback: ${String(e)}`);
            });
    }

    #cpuFrame(target: THREE.RenderTarget, w: number, h: number): void {
        if (this.#cpuBusy || this.#ipcBusy) {
            this.timings.vcamDropped++;
            this.timings.vcamDropIpc++;
            return;
        }
        this.#resize(w, h);
        this.#cpuBusy = true;
        const t0 = performance.now();
        this.#renderer
            .readRenderTargetPixelsAsync(target, 0, 0, w, h)
            .then((px) => {
                const t1 = performance.now();
                this.timings.vcamReadback = ema(this.timings.vcamReadback, t1 - t0);
                const frame = this.#nextFrame();
                const rgba = px instanceof Uint8Array ? px : new Uint8Array(px.buffer);
                rgbaToNv12(rgba, w, h, frame, Math.ceil((w * 4) / 256) * 256);
                this.timings.vcamConvert = ema(this.timings.vcamConvert, performance.now() - t1);
                this.#cpuBusy = false;
                this.#send(frame, w, h);
            })
            .catch((e: unknown) => {
                this.#cpuBusy = false;
                this.#onError(`vcam readback: ${String(e)}`);
            });
    }

    #nextFrame(): Uint8Array {
        this.#frameSlot = (this.#frameSlot + 1) % this.#frames.length;
        const f = this.#frames[this.#frameSlot];
        if (!f) throw new Error("vcam frame pool empty");
        return f;
    }

    #ensureSocket(): void {
        if (!this.#ipc || this.#ws || this.#wsConnecting || performance.now() < this.#wsRetryAt) return;
        this.#wsConnecting = true;
        invoke<{ port: number; token: string }>("vcam_endpoint")
            .then(({ port, token }) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/${token}`);
                ws.binaryType = "arraybuffer";
                ws.onopen = () => {
                    this.#ws = ws;
                    this.#wsConnecting = false;
                };
                const drop = () => {
                    if (this.#ws === ws) this.#ws = null;
                    this.#wsConnecting = false;
                    this.#wsRetryAt = performance.now() + 2000;
                };
                ws.onclose = drop;
                ws.onerror = drop;
            })
            .catch(() => {
                this.#wsConnecting = false;
                this.#wsRetryAt = performance.now() + 5000;
            });
    }

    /** True when a frame of `bytes` can go out on the socket now (open, not backed up). */
    #socketReady(bytes: number): boolean {
        if (!this.#ipc) return false;
        this.#ensureSocket();
        const ws = this.#ws;
        return ws !== null && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= bytes * 2;
    }

    #send(frame: Uint8Array, w: number, h: number): void {
        if (!this.#ipc) {
            this.#delivered++;
            return;
        }
        this.#ensureSocket();
        const ws = this.#ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            // Back-pressure: never queue more than ~2 frames in the socket.
            if (ws.bufferedAmount > frame.byteLength * 2) {
                this.timings.vcamDropped++;
                this.timings.vcamDropWs++;
                return;
            }
            const t0 = performance.now();
            const msg = this.#wire(frame, w, h);
            ws.send(msg);
            this.#delivered++;
            this.timings.vcamIpc = ema(this.timings.vcamIpc, performance.now() - t0);
            return;
        }
        if (this.#ipcBusy) {
            this.timings.vcamDropped++;
            this.timings.vcamDropIpc++;
            return;
        }
        this.#ipcBusy = true;
        const t0 = performance.now();
        invoke("vcam_frame", frame, { headers: { "x-w": String(w), "x-h": String(h) } })
            .then(() => {
                this.#delivered++;
                this.timings.vcamIpc = ema(this.timings.vcamIpc, performance.now() - t0);
            })
            .catch((e: unknown) => this.#onError(`vcam_frame: ${String(e)}`))
            .finally(() => {
                this.#ipcBusy = false;
            });
    }

    #wireBuf: Uint8Array<ArrayBuffer> | null = null;

    /** `u32 LE width | u32 LE height | NV12`, reusing one buffer. */
    #wire(frame: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
        const need = frame.byteLength + 8;
        if (this.#wireBuf?.byteLength !== need) this.#wireBuf = new Uint8Array(need);
        const buf = this.#wireBuf;
        const view = new DataView(buf.buffer);
        view.setUint32(0, w, true);
        view.setUint32(4, h, true);
        buf.set(frame, 8);
        return buf;
    }

    dispose(): void {
        if (this.#poll) clearInterval(this.#poll);
        this.#poll = null;
        this.#ws?.close();
        this.#ws = null;
        const g = this.#gpu;
        if (g) {
            g.out?.destroy();
            g.params.destroy();
            for (const s of g.staging) if (!s.busy) s.buf.destroy();
        }
        this.#gpu = null;
    }
}
