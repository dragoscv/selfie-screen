import type { BeautySettings } from "@tiksee/core";
import * as THREE from "three/webgpu";
import { attribute, float, positionGeometry, vec4 } from "three/tsl";

import { FACE_OVAL, FACE_TRIANGLES, LEFT_BROW, LEFT_EYE, LEFT_IRIS, LIPS_INNER, LIPS_OUTER, RIGHT_BROW, RIGHT_EYE, RIGHT_IRIS } from "./face-regions.js";

/**
 * Beauty (lazy chunk): the owner's 478 face landmarks -> a region mask in OUTPUT space
 * (R = face skin, G = eyes + under-eye band, B = lips, A = mouth opening / teeth) rendered on the
 * GPU each frame, plus the warp anchors (eye centres, cheeks, jaw, nose, chin) the camera shader
 * uses. Landmarks arrive 40-80 ms late and at the vision rate, so the face is moved with a
 * predicted similarity transform (translation, scale, rotation) to render time, and the mask
 * edges are feathered: a slightly misplaced soft mask is invisible, a hard one is not.
 */

export type RawToOutput = (x: number, y: number) => [number, number];

/** Warp anchors in OUTPUT uv (y down) for the camera shader. */
export interface BeautyAnchors {
    /** Eye centres and radii (as a fraction of output height). */
    eyeL: [number, number, number];
    eyeR: [number, number, number];
    /** Face centre line point and face width (output uv). */
    centre: [number, number];
    faceW: number;
    /** Cheek points (left/right), jaw points (left/right), nose tip, chin. */
    cheekL: [number, number];
    cheekR: [number, number];
    jawL: [number, number];
    jawR: [number, number];
    nose: [number, number];
    chin: [number, number];
    /** 0..1: warps fade out while the head moves fast (a lagging warp is very visible). */
    warpGain: number;
}

const N = 478;
/** Landmarks used as anchors (MediaPipe face mesh indices). */
const IDX = { noseTip: 1, chin: 152, cheekL: 425, cheekR: 205, jawL: 397, jawR: 172, forehead: 10, eyeLOuter: 263, eyeLInner: 362, eyeROuter: 33, eyeRInner: 133 };
/** Under-eye band: lower-lid landmarks pushed down by this share of the eye width. */
const UNDER_EYE_DROP = 0.55;
/** Maximum forward prediction (ms): beyond this a wrong guess hurts more than the lag. */
const MAX_PREDICT_MS = 90;
/** Head speed (face widths per second) where warps are fully faded out. */
const WARP_FADE_SPEED = 1.2;

interface Pose2 {
    cx: number;
    cy: number;
    s: number;
    a: number;
}

/** Similarity pose of a landmark set: centroid, scale (eye distance), angle (eye line). */
function pose2(lm: Float32Array): Pose2 {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < N; i++) {
        cx += lm[i * 2] ?? 0;
        cy += lm[i * 2 + 1] ?? 0;
    }
    const ex = (lm[IDX.eyeLOuter * 2] ?? 0) - (lm[IDX.eyeROuter * 2] ?? 0);
    const ey = (lm[IDX.eyeLOuter * 2 + 1] ?? 0) - (lm[IDX.eyeROuter * 2 + 1] ?? 0);
    return { cx: cx / N, cy: cy / N, s: Math.max(Math.hypot(ex, ey), 1e-4), a: Math.atan2(ey, ex) };
}

/** Polygon fan triangles (index triples) for a closed loop around its first vertex. */
function fan(loop: readonly number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i + 1 < loop.length; i++) out.push(loop[0] ?? 0, loop[i] ?? 0, loop[i + 1] ?? 0);
    return out;
}

/**
 * Region geometry: vertex = (landmark index | synthetic id, channel weights). Each region is its own
 * triangle list with a per-vertex RGBA weight; regions are drawn with MAX blending, skin is drawn
 * first and holes (eyes, brows, lips) are cut by drawing skin=0 on top with a separate pass order.
 */
interface Region {
    /** Triangles as landmark indices; >= N refers to the synthetic under-eye points. */
    tris: number[];
    color: [number, number, number, number];
}

/** Under-eye synthetic points: one per lower-lid landmark, dropped below the eye. */
const LOWER_LID_L = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const LOWER_LID_R = [33, 7, 163, 144, 145, 153, 154, 155, 133];

function underEye(lid: readonly number[], base: number): number[] {
    // Strip between the lid points (i) and their dropped copies (base + i).
    const tris: number[] = [];
    for (let i = 0; i + 1 < lid.length; i++) {
        const a = lid[i] ?? 0;
        const b = lid[i + 1] ?? 0;
        tris.push(a, b, base + i, b, base + i + 1, base + i);
    }
    return tris;
}

const SYN_L = N;
const SYN_R = N + LOWER_LID_L.length;
const VERTS = SYN_R + LOWER_LID_R.length;

const SKIN: Region = { tris: [...FACE_TRIANGLES], color: [1, 0, 0, 0] };
const HOLES: Region[] = [
    { tris: fan(LEFT_EYE), color: [0, 1, 0, 0] },
    { tris: fan(RIGHT_EYE), color: [0, 1, 0, 0] },
    { tris: fan(LEFT_BROW), color: [0, 0, 0, 0] },
    { tris: fan(RIGHT_BROW), color: [0, 0, 0, 0] },
    // Lips B = 1; mouth opening B = 0.5 (teeth): 3 channels only, alpha is not reliable on every backend.
    { tris: fan(LIPS_OUTER), color: [0, 0, 1, 1] },
    { tris: fan(LIPS_INNER), color: [0, 0, 0.5, 1] },
];
const UNDER: Region = { tris: [...underEye(LOWER_LID_L, SYN_L), ...underEye(LOWER_LID_R, SYN_R)], color: [1, 0.6, 0, 0] };

/** Build one indexed geometry whose triangles carry their region colour (duplicated vertices per region). */
function buildGeometry(): { geo: THREE.BufferGeometry; src: Int32Array } {
    const regions: Region[] = [SKIN, UNDER, ...HOLES];
    let count = 0;
    for (const r of regions) count += r.tris.length;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 4);
    const src = new Int32Array(count);
    let k = 0;
    // Later regions sit nearer the ortho camera (+z), so the depth test lets them replace skin.
    regions.forEach((r, ri) => {
        for (const v of r.tris) {
            src[k] = v;
            pos[k * 3 + 2] = ri * 0.01;
            col.set(r.color, k * 4);
            k++;
        }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("tint", new THREE.BufferAttribute(col, 4));
    return { geo, src };
}

export class BeautyMask {
    readonly target: THREE.RenderTarget;
    readonly #scene = new THREE.Scene();
    readonly #camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1, 1);
    readonly #mesh: THREE.Mesh;
    readonly #src: Int32Array;
    readonly #pos: THREE.BufferAttribute;
    /** Working landmarks in OUTPUT uv (x, y) for every vertex id incl. synthetic ones. */
    readonly #uv = new Float32Array(VERTS * 2);
    #last: { lm: Float32Array; t: number; pose: Pose2 } | null = null;
    #prev: { t: number; pose: Pose2 } | null = null;
    #seenAt = -Infinity;
    #speed = 0;
    anchors: BeautyAnchors | null = null;
    /** 0..1 fade of the whole effect when the face is lost / found. */
    presence = 0;

    constructor(width: number, height: number) {
        this.target = new THREE.RenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1), {
            depthBuffer: true,
            generateMipmaps: false,
            type: THREE.UnsignedByteType,
            colorSpace: THREE.NoColorSpace,
        });
        this.target.texture.minFilter = THREE.LinearFilter;
        this.target.texture.magFilter = THREE.LinearFilter;
        const { geo, src } = buildGeometry();
        this.#src = src;
        this.#pos = geo.getAttribute("position") as THREE.BufferAttribute;
        const m = new THREE.MeshBasicNodeMaterial();
        // Positions are OUTPUT uv (x right, y DOWN) in xy: map straight to clip space (no camera),
        // so the mask texel at output uv (u, v) is the one the camera shader samples at (u, 1 - v).
        m.vertexNode = vec4(positionGeometry.x.mul(2).sub(1), float(1).sub(positionGeometry.y.mul(2)), float(0.5).sub(positionGeometry.z), 1);
        // Opaque write of the region weights. outputNode bypasses lighting, tone mapping AND the
        // renderer's output colour-space conversion: the values are data, not colours (a plain
        // colorNode was converted and every channel came out ~equal, measured 2026-10-08).
        m.outputNode = vec4(attribute("tint", "vec4").xyz, float(1));
        m.transparent = false;
        m.toneMapped = false;
        m.blending = THREE.NoBlending;
        m.depthTest = true;
        m.depthWrite = true;
        m.side = THREE.DoubleSide;
        this.#mesh = new THREE.Mesh(geo, m);
        this.#mesh.frustumCulled = false;
        this.#scene.add(this.#mesh);
    }

    resize(width: number, height: number): void {
        this.target.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    }

    /** A fresh landmark set from vision (RAW camera coords 0..1, x/y pairs). */
    push(lm: Float32Array, captureMs: number): void {
        const pose = pose2(lm);
        if (this.#last) {
            this.#prev = { t: this.#last.t, pose: this.#last.pose };
            const dt = Math.max((captureMs - this.#last.t) / 1000, 1e-3);
            const v = Math.hypot(pose.cx - this.#last.pose.cx, pose.cy - this.#last.pose.cy) / pose.s / dt;
            this.#speed += (v - this.#speed) * 0.4;
        }
        this.#last = { lm, t: captureMs, pose };
        this.#seenAt = performance.now();
    }

    /** Update vertex positions for render time `nowMs` and render the mask. */
    render(renderer: THREE.WebGPURenderer, nowMs: number, toOutput: RawToOutput, dt: number): void {
        const last = this.#last;
        const fresh = last !== null && nowMs - this.#seenAt < 400;
        this.presence += ((fresh ? 1 : 0) - this.presence) * (1 - Math.exp(-dt / 0.15));
        if (!last) {
            this.anchors = null;
            return;
        }
        // Predict the similarity pose forward from the last two results (capped).
        let tx = 0;
        let ty = 0;
        let ks = 1;
        let ka = 0;
        const prev = this.#prev;
        if (prev && last.t > prev.t) {
            const ahead = Math.min(nowMs - last.t, MAX_PREDICT_MS);
            const f = Math.max(0, ahead) / (last.t - prev.t);
            tx = (last.pose.cx - prev.pose.cx) * f;
            ty = (last.pose.cy - prev.pose.cy) * f;
            ks = 1 + (last.pose.s / prev.pose.s - 1) * f;
            let da = last.pose.a - prev.pose.a;
            da = Math.atan2(Math.sin(da), Math.cos(da));
            ka = da * f;
        }
        const { cx, cy } = last.pose;
        const ca = Math.cos(ka);
        const sa = Math.sin(ka);
        const lm = last.lm;
        const uvs = this.#uv;
        const place = (i: number, x: number, y: number) => {
            const dx = (x - cx) * ks;
            const dy = (y - cy) * ks;
            const [u, v] = toOutput(cx + tx + dx * ca - dy * sa, cy + ty + dx * sa + dy * ca);
            uvs[i * 2] = u;
            uvs[i * 2 + 1] = v;
        };
        for (let i = 0; i < N; i++) place(i, lm[i * 2] ?? 0, lm[i * 2 + 1] ?? 0);
        // Under-eye points: lower lid dropped by a share of the eye width, in RAW space.
        const drop = (lid: readonly number[], base: number, outer: number, inner: number) => {
            const ew = Math.hypot((lm[outer * 2] ?? 0) - (lm[inner * 2] ?? 0), (lm[outer * 2 + 1] ?? 0) - (lm[inner * 2 + 1] ?? 0));
            // "Down" = perpendicular to the eye line (towards the chin).
            const chinY = lm[IDX.chin * 2 + 1] ?? 1;
            const foreY = lm[IDX.forehead * 2 + 1] ?? 0;
            const sgn = chinY >= foreY ? 1 : -1;
            const nx = -Math.sin(last.pose.a) * sgn;
            const ny = Math.cos(last.pose.a) * sgn;
            lid.forEach((id, j) => {
                const taper = Math.sin((j / (lid.length - 1)) * Math.PI);
                place(base + j, (lm[id * 2] ?? 0) + nx * ew * UNDER_EYE_DROP * taper, (lm[id * 2 + 1] ?? 0) + ny * ew * UNDER_EYE_DROP * taper);
            });
        };
        drop(LOWER_LID_L, SYN_L, IDX.eyeLOuter, IDX.eyeLInner);
        drop(LOWER_LID_R, SYN_R, IDX.eyeROuter, IDX.eyeRInner);

        const p = this.#pos.array as Float32Array;
        for (let k = 0; k < this.#src.length; k++) {
            const id = this.#src[k] ?? 0;
            p[k * 3] = uvs[id * 2] ?? 0;
            p[k * 3 + 1] = uvs[id * 2 + 1] ?? 0;
        }
        this.#pos.needsUpdate = true;

        const at = (i: number): [number, number] => [uvs[i * 2] ?? 0, uvs[i * 2 + 1] ?? 0];
        const ring = (ids: readonly number[]): [number, number, number] => {
            let x = 0;
            let y = 0;
            for (const id of ids) {
                x += uvs[id * 2] ?? 0;
                y += uvs[id * 2 + 1] ?? 0;
            }
            x /= ids.length;
            y /= ids.length;
            let r = 0;
            for (const id of ids) r = Math.max(r, Math.hypot((uvs[id * 2] ?? 0) - x, (uvs[id * 2 + 1] ?? 0) - y));
            return [x, y, r];
        };
        const eyeL = ring(LEFT_EYE);
        const eyeR = ring(RIGHT_EYE);
        const [ox, oy, faceR] = ring(FACE_OVAL);
        void LEFT_IRIS;
        void RIGHT_IRIS;
        this.anchors = {
            eyeL,
            eyeR,
            centre: [ox, oy],
            faceW: faceR * 2,
            cheekL: at(IDX.cheekL),
            cheekR: at(IDX.cheekR),
            jawL: at(IDX.jawL),
            jawR: at(IDX.jawR),
            nose: at(IDX.noseTip),
            chin: at(IDX.chin),
            warpGain: Math.max(0, 1 - this.#speed / WARP_FADE_SPEED) * this.presence,
        };

        const prevTarget = renderer.getRenderTarget();
        const clear = new THREE.Color();
        renderer.getClearColor(clear);
        const alpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(this.target);
        renderer.clear();
        renderer.render(this.#scene, this.#camera);
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(clear, alpha);
    }

    /**
     * Dev diagnosis: read the mask back and report each channel's coverage centroid in output
     * uv (row 0 of the readback taken as the TOP), next to the anchors' face centre.
     */
    async debugLine(renderer: THREE.WebGPURenderer): Promise<string> {
        const w = this.target.width;
        const h = this.target.height;
        const px = (await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, w, h)) as Uint8Array;
        const stride = px.length / h;
        const acc = [0, 0, 0, 0].map(() => ({ n: 0, x: 0, y: 0 }));
        for (let y = 0; y < h; y += 2)
            for (let x = 0; x < w; x += 2) {
                const i = y * stride + x * 4;
                for (let c = 0; c < 4; c++)
                    if ((px[i + c] ?? 0) > 127) {
                        const a = acc[c];
                        if (a) {
                            a.n++;
                            a.x += x / w;
                            a.y += y / h;
                        }
                    }
            }
        const f = (a: { n: number; x: number; y: number }) => (a.n ? `${(a.x / a.n).toFixed(3)},${(a.y / a.n).toFixed(3)}#${a.n}` : "-");
        const an = this.anchors;
        return `[beauty] mask ${w}x${h} R=${f(acc[0] ?? { n: 0, x: 0, y: 0 })} G=${f(acc[1] ?? { n: 0, x: 0, y: 0 })} B=${f(acc[2] ?? { n: 0, x: 0, y: 0 })} A=${f(acc[3] ?? { n: 0, x: 0, y: 0 })} anchors.centre=${an ? `${an.centre[0].toFixed(3)},${an.centre[1].toFixed(3)} w=${an.faceW.toFixed(3)} gain=${an.warpGain.toFixed(2)}` : "-"} presence=${this.presence.toFixed(2)} speed=${this.#speed.toFixed(2)}`;
    }

    dispose(): void {
        this.target.dispose();
        this.#mesh.geometry.dispose();
        (this.#mesh.material as THREE.Material).dispose();
    }
}

/** Uniform values for the camera shader from the settings and the current anchors. */
export function beautyUniforms(b: BeautySettings, a: BeautyAnchors | null, presence: number): BeautyParams {
    const on = b.enabled && a !== null ? presence : 0;
    return {
        on,
        smooth: b.skin.smooth * on,
        even: b.skin.even * on,
        brighten: b.skin.brighten * on,
        blush: b.skin.blush * on,
        eyeBright: b.eyes.brighten * on,
        darkCircles: b.eyes.darkCircles * on,
        teeth: b.teeth.whiten * on,
        lips: b.lips.amount * on,
        lipHue: b.lips.hue,
        enlarge: b.eyes.enlarge * on * (a?.warpGain ?? 0),
        slim: b.shape.slim * on * (a?.warpGain ?? 0),
        jaw: b.shape.jaw * on * (a?.warpGain ?? 0),
        nose: b.shape.nose * on * (a?.warpGain ?? 0),
        chin: b.shape.chin * on * (a?.warpGain ?? 0),
        anchors: a,
    };
}

export interface BeautyParams {
    on: number;
    smooth: number;
    even: number;
    brighten: number;
    blush: number;
    eyeBright: number;
    darkCircles: number;
    teeth: number;
    lips: number;
    lipHue: number;
    enlarge: number;
    slim: number;
    jaw: number;
    nose: number;
    chin: number;
    anchors: BeautyAnchors | null;
}
