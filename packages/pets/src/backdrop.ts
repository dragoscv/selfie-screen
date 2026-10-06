import * as THREE from "three/webgpu";
import { abs, exp, float, length, max, mix, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

import { uprightToRawAffine, type Framing, type Rotation } from "./framing.js";

export interface BackdropLook {
    /** Exposure in stops. */
    exposure: number;
    /** -1 cool .. 1 warm. */
    warmth: number;
    /** 0..1 edge-preserving skin smoothing. */
    smoothing: number;
    /** 0..1 background blur; needs a person mask. */
    backgroundBlur: number;
}

/** Synthetic depth of field: the face stays sharp, the rest blurs by depth (or by mask + distance). */
export interface BackdropDof {
    /** 0 disables. */
    strength: number;
    /** Focus point, output-normalised (y down). */
    focusX: number;
    focusY: number;
    /** Sharp radius around the focus point, as a fraction of the output height. */
    radius: number;
}

function makeUniforms() {
    return {
        scale: uniform(new THREE.Vector2(1, 1)),
        offset: uniform(new THREE.Vector2(0, 0)),
        mirror: uniform(1),
        texel: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)),
        exposure: uniform(0),
        warmth: uniform(0),
        smoothing: uniform(0),
        blur: uniform(0),
        hasMask: uniform(0),
        hasDepth: uniform(0),
        /** Metres = depthK / inverse-depth (calibrated so the owner's face = ownerDistanceM). */
        depthK: uniform(1),
        /** Inverse depth (0..1) at the focus point. */
        focusDepth: uniform(0.5),
        dof: uniform(0),
        focus: uniform(new THREE.Vector2(0.5, 0.35)),
        focusR: uniform(0.08),
        /** Output width / height, for round focus regions. */
        aspect: uniform(9 / 16),
        /** Upright -> raw camera uv: raw = (rx · (u, v, 1), ry · (u, v, 1)). */
        rx: uniform(new THREE.Vector3(1, 0, 0)),
        ry: uniform(new THREE.Vector3(0, 1, 0)),
    };
}

type Vec2Node = THREE.Node<"vec2">;
type Vec3Node = THREE.Node<"vec3">;
type FloatNode = THREE.Node<"float">;

function placeholder(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
}

function upload(tex: THREE.DataTexture, data: Float32Array, width: number, height: number): void {
    const img = tex.image as { data: Float32Array; width: number; height: number };
    if (img.width !== width || img.height !== height) {
        tex.dispose();
        img.data = new Float32Array(width * height);
        img.width = width;
        img.height = height;
    }
    img.data.set(data.subarray(0, width * height));
    tex.needsUpdate = true;
}

/**
 * The camera image as a full-frame quad in pixel space, filtered in one TSL
 * pass: cover-crop + mirror (+ digital crop), exposure, white balance,
 * bilateral skin smoothing, mask-driven background blur and synthetic depth
 * of field. The engine renders it alone into the camera render target (the
 * image monitor aids and scopes judge) and composites pets/AR on top.
 *
 * `maskAt` / `personDepthAt` sample the person mask and depth map at an
 * OUTPUT uv with the same mapping, so AR materials can occlude against the
 * person without a second pass.
 */
export class Backdrop {
    readonly mesh: THREE.Mesh;
    readonly #video: THREE.VideoTexture;
    readonly #mask = placeholder();
    readonly #depth = placeholder();
    readonly #u = makeUniforms();

    constructor(video: HTMLVideoElement) {
        this.#video = new THREE.VideoTexture(video);
        this.#video.colorSpace = THREE.SRGBColorSpace;
        this.#video.generateMipmaps = false;
        const u = this.#u;

        // Output uv is y-down here (plane uv.y=0 sits at the top of the y-down camera).
        const out = uv();
        const [vx, vy] = this.#upright(out);
        // Video textures are flipY: v=0 is the bottom row of the frame. Texel offsets are in upright pixels.
        const at = (dx: number, dy: number) => {
            const px: FloatNode = vx.add(u.texel.x.mul(dx));
            const py: FloatNode = vy.add(u.texel.y.mul(dy));
            const [rx, ry] = this.#raw(px, py);
            return texture(this.#video, vec2(rx, float(1).sub(ry))).rgb;
        };

        const centre = at(0, 0);

        // Bilateral smoothing: 5x5 taps, 2 px apart, colour-distance weighted.
        let sum: Vec3Node = vec3(0);
        let wsum: FloatNode = float(0);
        for (let y = -2; y <= 2; y++) {
            for (let x = -2; x <= 2; x++) {
                const c = x === 0 && y === 0 ? centre : at(x * 2, y * 2);
                const d = c.sub(centre);
                const w = exp(d.dot(d).mul(-90)).mul(exp(float(-(x * x + y * y) / 8)));
                sum = sum.add(c.mul(w));
                wsum = wsum.add(w);
            }
        }
        const smoothed = mix(centre, sum.div(max(wsum, 1e-4)), u.smoothing);

        // Blur: a 16-tap ring at two radii, shared by background blur and DoF.
        let bg: Vec3Node = vec3(0);
        const taps = 16;
        for (let i = 0; i < taps; i++) {
            const a = (i / taps) * Math.PI * 2;
            const r = i % 2 === 0 ? 14 : 28;
            bg = bg.add(at(Math.cos(a) * r, Math.sin(a) * r));
        }
        bg = bg.div(taps);
        const [mx, my] = this.#raw(vx, vy);
        // Mask rows are top-down and the DataTexture is not flipped: sample y as-is.
        const person = texture(this.#mask, vec2(mx, my)).r;
        const keep = mix(float(1), person.smoothstep(0.35, 0.75), u.hasMask);
        const blurAmount: FloatNode = u.blur.mul(float(1).sub(keep));
        // DoF: by depth difference to the face when a depth map exists, else mask + radial falloff.
        const inv = texture(this.#depth, vec2(mx, my)).r;
        const byDepth = abs(inv.sub(u.focusDepth)).mul(3).clamp(0, 1);
        const d = out.sub(u.focus).mul(vec2(u.aspect, float(1)));
        const radial = length(d).smoothstep(u.focusR, u.focusR.mul(3)).mul(0.6);
        const byMask = max(float(1).sub(keep), radial);
        const dofAmount: FloatNode = u.dof.mul(u.hasDepth.greaterThan(0.5).select(byDepth, byMask));
        const background = mix(smoothed, bg, max(blurAmount, dofAmount).clamp(0, 1));

        const gain = float(2).pow(u.exposure);
        const wb = vec3(float(1).add(u.warmth.mul(0.08)), float(1), float(1).sub(u.warmth.mul(0.08)));
        const graded = background.mul(gain).mul(wb).clamp(0, 1);

        const material = new THREE.MeshBasicNodeMaterial();
        material.colorNode = vec4(graded, 1);
        material.blending = THREE.NoBlending;
        material.depthTest = false;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;

        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        this.mesh.renderOrder = -1;
        this.mesh.frustumCulled = false;
    }

    /** Output uv -> upright camera uv (cover crop + mirror). */
    #upright(out: Vec2Node): [FloatNode, FloatNode] {
        const u = this.#u;
        const ux = mix(out.x, float(1).sub(out.x), u.mirror);
        return [u.offset.x.add(ux.mul(u.scale.x)), u.offset.y.add(out.y.mul(u.scale.y))];
    }

    /** Upright camera uv -> raw camera uv (sideways-mounted camera). */
    #raw(x: FloatNode, y: FloatNode): [FloatNode, FloatNode] {
        const u = this.#u;
        return [u.rx.x.mul(x).add(u.rx.y.mul(y)).add(u.rx.z), u.ry.x.mul(x).add(u.ry.y.mul(y)).add(u.ry.z)];
    }

    /** Person mask (0..1) at an output uv (y down); 0 when no mask is available. */
    maskAt(out: Vec2Node): FloatNode {
        const [x, y] = this.#upright(out);
        const [rx, ry] = this.#raw(x, y);
        return texture(this.#mask, vec2(rx, ry)).r.smoothstep(0.4, 0.6).mul(this.#u.hasMask);
    }

    /** Metric depth (m) of whatever is at an output uv, from the depth map; 1e3 when there is none. */
    personDepthAt(out: Vec2Node): FloatNode {
        const [x, y] = this.#upright(out);
        const [rx, ry] = this.#raw(x, y);
        const inv = texture(this.#depth, vec2(rx, ry)).r;
        return this.#u.hasDepth.greaterThan(0.5).select(this.#u.depthK.div(max(inv, 0.02)), float(1e3));
    }

    /** 1 when a depth map is bound (per-pixel occlusion), else 0. */
    get hasDepthNode(): FloatNode {
        return this.#u.hasDepth;
    }

    /** Fit the quad to the output and point it at the right crop of the camera. */
    /** `uprightW/H` = camera frame size after rotation. */
    layout(width: number, height: number, framing: Framing, uprightW: number, uprightH: number, rotation: Rotation = 0): void {
        this.mesh.scale.set(width, height, 1);
        this.mesh.position.set(width / 2, height / 2, -900);
        this.#u.scale.value.set(framing.scaleX, framing.scaleY);
        this.#u.offset.value.set(framing.offsetX, framing.offsetY);
        this.#u.mirror.value = framing.mirror ? 1 : 0;
        this.#u.texel.value.set(1 / Math.max(uprightW, 1), 1 / Math.max(uprightH, 1));
        this.#u.aspect.value = width / Math.max(height, 1);
        const [rx, ry] = uprightToRawAffine(rotation);
        this.#u.rx.value.set(...rx);
        this.#u.ry.value.set(...ry);
    }

    setLook(look: BackdropLook): void {
        this.#u.exposure.value = look.exposure;
        this.#u.warmth.value = look.warmth;
        this.#u.smoothing.value = look.smoothing;
        this.#u.blur.value = look.backgroundBlur;
    }

    setDof(dof: BackdropDof): void {
        this.#u.dof.value = dof.strength;
        this.#u.focus.value.set(dof.focusX, dof.focusY);
        this.#u.focusR.value = dof.radius;
    }

    /** Person mask in camera space, row 0 = top, values 0..1. Null disables blur masking. */
    setMask(mask: Float32Array | null, width: number, height: number): void {
        if (!mask) {
            this.#u.hasMask.value = 0;
            return;
        }
        upload(this.#mask, mask, width, height);
        this.#u.hasMask.value = 1;
    }

    /**
     * Relative inverse depth (1 = near) in raw camera space, row 0 = top. `k` maps it to metres
     * (m = k / inv); `focusInv` is the inverse depth at the face. Null falls back to mask-only.
     */
    setDepth(depth: Float32Array | null, width: number, height: number, k = 1, focusInv = 0.5): void {
        if (!depth) {
            this.#u.hasDepth.value = 0;
            return;
        }
        upload(this.#depth, depth, width, height);
        this.#u.hasDepth.value = 1;
        this.#u.depthK.value = k;
        this.#u.focusDepth.value = focusInv;
    }

    dispose(): void {
        this.#video.dispose();
        this.#mask.dispose();
        this.#depth.dispose();
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}
