import * as THREE from "three/webgpu";
import { screenUV, texture } from "three/tsl";

import type { Scopes } from "./controller.js";

/** Short side of the scope readback; the long side follows the output aspect (160x284 portrait). */
export const SCOPE_SHORT = 160;
export const SCOPE_HZ = 10;
export const VECTOR_SIZE = 128;

export interface ScopeBuffers {
    r: Float32Array;
    g: Float32Array;
    b: Float32Array;
    y: Float32Array;
    wave: Float32Array;
    vec: Float32Array;
}

export function scopeBuffers(width: number): ScopeBuffers {
    return {
        r: new Float32Array(256),
        g: new Float32Array(256),
        b: new Float32Array(256),
        y: new Float32Array(256),
        wave: new Float32Array(width * 256),
        vec: new Float32Array(VECTOR_SIZE * VECTOR_SIZE),
    };
}

function normalise(a: Float32Array): void {
    let max = 0;
    for (let i = 0; i < a.length; i++) if ((a[i] ?? 0) > max) max = a[i] ?? 0;
    if (max <= 0) return;
    const k = 1 / max;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] ?? 0) * k;
}

/**
 * Histogram (R, G, B, Y 256 bins), waveform (width x 256, row 0 = 100 %),
 * vectorscope (128x128 Cb/Cr, centre = neutral), clipping shares and the mean
 * face luma in IRE. Input: sRGB-encoded RGBA bytes with `stride` bytes per
 * row. `face` is output-normalised (x, y top-left, w, h). Reuses `buf`.
 */
export function computeScopes(
    rgba: Uint8Array,
    width: number,
    height: number,
    stride: number,
    buf: ScopeBuffers,
    face?: { x: number; y: number; w: number; h: number },
): Scopes {
    buf.r.fill(0);
    buf.g.fill(0);
    buf.b.fill(0);
    buf.y.fill(0);
    buf.wave.fill(0);
    buf.vec.fill(0);
    let hi = 0;
    let lo = 0;
    let faceSum = 0;
    let faceN = 0;
    const fx0 = face ? Math.floor(face.x * width) : 0;
    const fx1 = face ? Math.ceil((face.x + face.w) * width) : -1;
    const fy0 = face ? Math.floor(face.y * height) : 0;
    const fy1 = face ? Math.ceil((face.y + face.h) * height) : -1;
    const half = VECTOR_SIZE / 2;
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        const inFaceRow = y >= fy0 && y < fy1;
        for (let x = 0; x < width; x++) {
            const p = row + x * 4;
            const r = rgba[p] ?? 0;
            const g = rgba[p + 1] ?? 0;
            const b = rgba[p + 2] ?? 0;
            // BT.709 luma on the encoded signal (what IRE is measured on).
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const li = Math.min(255, Math.round(l));
            buf.r[r] = (buf.r[r] ?? 0) + 1;
            buf.g[g] = (buf.g[g] ?? 0) + 1;
            buf.b[b] = (buf.b[b] ?? 0) + 1;
            buf.y[li] = (buf.y[li] ?? 0) + 1;
            const wi = (255 - li) * width + x;
            buf.wave[wi] = (buf.wave[wi] ?? 0) + 1;
            const cb = (b - l) / 1.8556;
            const cr = (r - l) / 1.5748;
            const vx = Math.min(VECTOR_SIZE - 1, Math.max(0, Math.round(half + (cb / 128) * half)));
            const vy = Math.min(VECTOR_SIZE - 1, Math.max(0, Math.round(half - (cr / 128) * half)));
            const vi = vy * VECTOR_SIZE + vx;
            buf.vec[vi] = (buf.vec[vi] ?? 0) + 1;
            if (li >= 252) hi++;
            else if (li <= 3) lo++;
            if (inFaceRow && x >= fx0 && x < fx1) {
                faceSum += l;
                faceN++;
            }
        }
    }
    normalise(buf.r);
    normalise(buf.g);
    normalise(buf.b);
    normalise(buf.y);
    normalise(buf.wave);
    normalise(buf.vec);
    const n = Math.max(width * height, 1);
    return {
        histogram: { r: buf.r, g: buf.g, b: buf.b, y: buf.y },
        waveform: { width, data: buf.wave },
        vectorscope: { size: VECTOR_SIZE, data: buf.vec },
        clipHigh: hi / n,
        clipLow: lo / n,
        ...(faceN > 0 ? { faceIre: (faceSum / faceN / 255) * 100 } : {}),
    };
}

export function scopeSize(outW: number, outH: number): [number, number] {
    return outW <= outH
        ? [SCOPE_SHORT, Math.round((SCOPE_SHORT * outH) / outW)]
        : [Math.round((SCOPE_SHORT * outW) / outH), SCOPE_SHORT];
}

/**
 * Downsamples the graded camera image (before pets/AR) into a small sRGB
 * target and reads it back at <= 10 Hz without stalling the frame. The CPU
 * pass over 160x284 px is ~0.5-1 ms; measured as `scopesMs`.
 */
export class ScopeSampler {
    readonly #target: THREE.RenderTarget;
    readonly #quad: THREE.QuadMesh;
    readonly #material: THREE.MeshBasicNodeMaterial;
    readonly #source: THREE.TextureNode;
    #buf: ScopeBuffers;
    #busy = false;
    #last = 0;
    #latest: Scopes = { clipHigh: 0, clipLow: 0 };
    /** EMA of the CPU scope pass, ms. */
    cpuMs = 0;
    readbackMs = 0;

    constructor(source: THREE.Texture) {
        this.#target = new THREE.RenderTarget(SCOPE_SHORT, SCOPE_SHORT, { colorSpace: THREE.SRGBColorSpace, depthBuffer: false });
        this.#source = texture(source, screenUV);
        const m = new THREE.MeshBasicNodeMaterial();
        m.colorNode = this.#source;
        m.blending = THREE.NoBlending;
        this.#material = m;
        this.#quad = new THREE.QuadMesh(m);
        this.#buf = scopeBuffers(SCOPE_SHORT);
    }

    get latest(): Scopes {
        return this.#latest;
    }

    setSource(source: THREE.Texture): void {
        this.#source.value = source;
    }

    /** Kick a readback when due. `face` is output-normalised. */
    sample(renderer: THREE.WebGPURenderer, outW: number, outH: number, now: number, face?: { x: number; y: number; w: number; h: number }): void {
        if (this.#busy || now - this.#last < 1000 / SCOPE_HZ) return;
        this.#last = now;
        const [w, h] = scopeSize(outW, outH);
        if (this.#target.width !== w || this.#target.height !== h) {
            this.#target.setSize(w, h);
            this.#buf = scopeBuffers(w);
        }
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(this.#target);
        this.#quad.render(renderer);
        renderer.setRenderTarget(prev);
        this.#busy = true;
        const t0 = performance.now();
        renderer
            .readRenderTargetPixelsAsync(this.#target, 0, 0, w, h)
            .then((px) => {
                const t1 = performance.now();
                this.readbackMs = this.readbackMs * 0.8 + (t1 - t0) * 0.2;
                const bytes = px instanceof Uint8Array ? px : new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
                this.#latest = computeScopes(bytes, w, h, Math.ceil((w * 4) / 256) * 256, this.#buf, face);
                this.cpuMs = this.cpuMs * 0.8 + (performance.now() - t1) * 0.2;
            })
            .catch(() => undefined)
            .finally(() => {
                this.#busy = false;
            });
    }

    dispose(): void {
        this.#target.dispose();
        this.#material.dispose();
    }
}
