import type { MonitorSettings } from "@tiksee/core";
import * as THREE from "three/webgpu";
import { float, fract, max, mix, screenUV, sRGBTransferOETF, texture, uniform, vec2, vec3, vec4 } from "three/tsl";

type FloatNode = THREE.Node<"float">;
type Vec3Node = THREE.Node<"vec3">;

/**
 * ARRI-style false colour on IRE (0..100, BT.709 luma of the encoded signal).
 * Everything not listed renders as grey luma.
 */
export const FALSE_COLOR: readonly { below: number; rgb: [number, number, number] | null }[] = [
    { below: 2.5, rgb: [0.5, 0.0, 0.6] }, // purple: crushed blacks
    { below: 4, rgb: [0.1, 0.35, 1.0] }, // blue: just above black
    { below: 38, rgb: null },
    { below: 42, rgb: [0.1, 0.8, 0.2] }, // green: 18 % grey
    { below: 52, rgb: null },
    { below: 56, rgb: [1.0, 0.55, 0.75] }, // pink: one stop over grey (skin)
    { below: 97, rgb: null },
    { below: 99, rgb: [1.0, 0.95, 0.1] }, // yellow: near clip
    { below: Infinity, rgb: [1.0, 0.1, 0.1] }, // red: clipped
];

/** JS mirror of the shader mapping (null = grey luma). */
export function falseColorFor(ire: number): [number, number, number] | null {
    for (const band of FALSE_COLOR) if (ire < band.below) return band.rgb;
    return null;
}

/** Which bounds a band needs in the shader: only finite ones (WGSL has no Infinity literal). */
export function bandBounds(lo: number, below: number): { lo?: number; below?: number } {
    return { ...(Number.isFinite(lo) ? { lo } : {}), ...(Number.isFinite(below) ? { below } : {}) };
}

/** Shader condition `lo <= ire < below`, emitting only finite comparisons. */
function falseColorBand(ire: FloatNode, lo: number, below: number): THREE.Node<"bool"> {
    const b = bandBounds(lo, below);
    if (b.lo !== undefined && b.below !== undefined) return ire.greaterThanEqual(b.lo).and(ire.lessThan(b.below));
    if (b.below !== undefined) return ire.lessThan(b.below);
    if (b.lo !== undefined) return ire.greaterThanEqual(b.lo);
    return ire.greaterThanEqual(-1e9);
}

export const PEAKING_RGB: Readonly<Record<MonitorSettings["peakingColor"], [number, number, number]>> = {
    red: [1, 0.1, 0.1],
    yellow: [1, 0.95, 0.1],
    white: [1, 1, 1],
    blue: [0.2, 0.5, 1],
};

/** True when the preview needs any aid (otherwise the cheap pass-through runs). */
export function monitorActive(m: MonitorSettings): boolean {
    return !m.cleanFeed && (m.peaking || m.zebra || m.falseColor || m.clipping);
}

/**
 * The studio canvas: OUTPUT frame + monitoring aids judged on the graded
 * CAMERA image (before pets/AR). Writes sRGB-encoded values to a non-sRGB
 * canvas (the renderer runs with a linear output colour space and no tone
 * mapping so nothing is converted twice).
 */
export class PreviewPass {
    readonly #u = {
        peaking: uniform(0),
        peakColor: uniform(new THREE.Vector3(1, 0.1, 0.1)),
        peakThreshold: uniform(0.15),
        zebra: uniform(0),
        zebraIre: uniform(95),
        falseColor: uniform(0),
        clipping: uniform(0),
        time: uniform(0),
        size: uniform(new THREE.Vector2(1080, 1920)),
    };
    readonly #aids: THREE.QuadMesh;
    readonly #plain: THREE.QuadMesh;
    readonly #materials: THREE.MeshBasicNodeMaterial[] = [];
    readonly #outputTex: THREE.TextureNode;
    readonly #cameraTex: THREE.TextureNode;
    readonly #plainTex: THREE.TextureNode;
    #active = false;

    constructor(output: THREE.Texture, camera: THREE.Texture) {
        const u = this.#u;
        const uvN = screenUV;
        this.#outputTex = texture(output, uvN);
        this.#cameraTex = texture(camera, uvN);
        this.#plainTex = texture(output, uvN);
        const enc = (c: Vec3Node): Vec3Node => sRGBTransferOETF(c) as Vec3Node;
        const base = enc(this.#outputTex.rgb);
        const w709 = vec3(0.2126, 0.7152, 0.0722);
        const lumaAt = (dx: number, dy: number): FloatNode => {
            const t = dx === 0 && dy === 0 ? this.#cameraTex : texture(camera, uvN.add(vec2(dx, dy).div(u.size)));
            return enc(t.rgb).dot(w709);
        };
        const y = lumaAt(0, 0);
        const ire = y.mul(100);

        // False colour replaces the image with grey luma + bands. Open-ended bands (the bottom one
        // from -inf, the top one to +inf) use a single comparison: `Infinity` has no WGSL literal
        // ("Infinity.0" made the whole aids shader fail to compile -> black preview, 2026-10-08).
        let fc: Vec3Node = vec3(y, y, y);
        let lo = -Infinity;
        for (const band of FALSE_COLOR) {
            if (band.rgb) {
                const inBand = falseColorBand(ire, lo, band.below);
                fc = inBand.select(vec3(...band.rgb), fc);
            }
            lo = band.below;
        }
        let col: Vec3Node = mix(base, fc, u.falseColor);

        // Zebras: animated diagonal stripes over everything at or above the level.
        const px = uvN.mul(u.size);
        const stripe = fract(px.x.add(px.y).div(14).sub(u.time.mul(1.5))).greaterThan(0.5);
        const zebraOn = u.zebra.greaterThan(0.5).and(ire.greaterThanEqual(u.zebraIre)).and(stripe);
        col = zebraOn.select(vec3(0.95, 0.95, 0.95), col);

        // Focus peaking: Sobel on camera luma.
        const a = lumaAt(-1, -1);
        const b = lumaAt(0, -1);
        const c = lumaAt(1, -1);
        const d = lumaAt(-1, 0);
        const f = lumaAt(1, 0);
        const g = lumaAt(-1, 1);
        const h = lumaAt(0, 1);
        const i = lumaAt(1, 1);
        const gx = c.add(f.mul(2)).add(i).sub(a.add(d.mul(2)).add(g));
        const gy = g.add(h.mul(2)).add(i).sub(a.add(b.mul(2)).add(c));
        const edge = max(gx.abs(), gy.abs());
        const peakOn = u.peaking.greaterThan(0.5).and(edge.greaterThan(u.peakThreshold));
        col = peakOn.select(u.peakColor, col);

        // Clipping blink (2 Hz): red over clipped highlights, blue over crushed blacks.
        const blink = fract(u.time.mul(2)).greaterThan(0.5).and(u.clipping.greaterThan(0.5));
        col = blink.and(ire.greaterThanEqual(99)).select(vec3(1, 0, 0), col);
        col = blink.and(ire.lessThanEqual(1)).select(vec3(0, 0.3, 1), col);

        this.#aids = new THREE.QuadMesh(this.#material(vec4(col, float(1))));
        this.#plain = new THREE.QuadMesh(this.#material(vec4(enc(this.#plainTex.rgb), float(1))));
    }

    #material(node: THREE.Node<"vec4">): THREE.MeshBasicNodeMaterial {
        const m = new THREE.MeshBasicNodeMaterial();
        m.colorNode = node;
        m.blending = THREE.NoBlending;
        m.depthTest = false;
        m.depthWrite = false;
        this.#materials.push(m);
        return m;
    }

    set(m: MonitorSettings): void {
        const u = this.#u;
        this.#active = monitorActive(m);
        u.peaking.value = m.peaking ? 1 : 0;
        u.peakColor.value.set(...PEAKING_RGB[m.peakingColor]);
        u.peakThreshold.value = m.peakingThreshold;
        u.zebra.value = m.zebra ? 1 : 0;
        u.zebraIre.value = m.zebraLevel;
        u.falseColor.value = m.falseColor ? 1 : 0;
        u.clipping.value = m.clipping ? 1 : 0;
    }

    setSources(output: THREE.Texture, camera: THREE.Texture): void {
        this.#outputTex.value = output;
        this.#plainTex.value = output;
        this.#cameraTex.value = camera;
    }

    /** Draw to the canvas (render target null). */
    render(renderer: THREE.WebGPURenderer, width: number, height: number, tSec: number): void {
        this.#u.time.value = tSec;
        this.#u.size.value.set(width, height);
        renderer.setRenderTarget(null);
        (this.#active ? this.#aids : this.#plain).render(renderer);
    }

    dispose(): void {
        for (const m of this.#materials) m.dispose();
        this.#materials.length = 0;
    }
}
