import * as THREE from "three/webgpu";
import { exp, float, max, mix, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

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
        /** Upright -> raw camera uv: raw = (rx · (u, v, 1), ry · (u, v, 1)). */
        rx: uniform(new THREE.Vector3(1, 0, 0)),
        ry: uniform(new THREE.Vector3(0, 1, 0)),
    };
}

type Vec3Node = THREE.Node<"vec3">;
type FloatNode = THREE.Node<"float">;

/**
 * The camera image as a full-frame quad in the PetStage's pixel-space scene,
 * filtered in one TSL pass: cover-crop + mirror, exposure, white balance,
 * bilateral skin smoothing and mask-driven background blur. It is drawn first
 * with depth off, so the pets always land on top in the same frame (Q33).
 */
export class Backdrop {
    readonly mesh: THREE.Mesh;
    readonly #video: THREE.VideoTexture;
    readonly #mask: THREE.DataTexture;
    readonly #u = makeUniforms();

    constructor(video: HTMLVideoElement) {
        this.#video = new THREE.VideoTexture(video);
        this.#video.colorSpace = THREE.SRGBColorSpace;
        this.#video.generateMipmaps = false;
        this.#mask = new THREE.DataTexture(new Float32Array([1]), 1, 1, THREE.RedFormat, THREE.FloatType);
        this.#mask.minFilter = THREE.LinearFilter;
        this.#mask.magFilter = THREE.LinearFilter;
        this.#mask.needsUpdate = true;
        const u = this.#u;

        // Output uv is y-down here (plane uv.y=0 sits at the top of the y-down camera).
        const out = uv();
        const ux = mix(out.x, float(1).sub(out.x), u.mirror);
        const vx = u.offset.x.add(ux.mul(u.scale.x));
        const vy = u.offset.y.add(out.y.mul(u.scale.y));
        // (vx, vy) are upright-frame coords; map to raw camera coords for a sideways-mounted camera.
        const rawX = (x: FloatNode, y: FloatNode): FloatNode => u.rx.x.mul(x).add(u.rx.y.mul(y)).add(u.rx.z);
        const rawY = (x: FloatNode, y: FloatNode): FloatNode => u.ry.x.mul(x).add(u.ry.y.mul(y)).add(u.ry.z);
        // Video textures are flipY: v=0 is the bottom row of the frame. Texel offsets are in upright pixels.
        const at = (dx: number, dy: number) => {
            const px: FloatNode = vx.add(u.texel.x.mul(dx));
            const py: FloatNode = vy.add(u.texel.y.mul(dy));
            return texture(this.#video, vec2(rawX(px, py), float(1).sub(rawY(px, py)))).rgb;
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

        // Background blur: a 16-tap ring at two radii, scaled by strength.
        let bg: Vec3Node = vec3(0);
        const taps = 16;
        for (let i = 0; i < taps; i++) {
            const a = (i / taps) * Math.PI * 2;
            const r = i % 2 === 0 ? 14 : 28;
            bg = bg.add(at(Math.cos(a) * r, Math.sin(a) * r));
        }
        bg = bg.div(taps);
        // Mask rows are top-down and the DataTexture is not flipped: sample y as-is.
        const person = texture(this.#mask, vec2(rawX(vx, vy), rawY(vx, vy))).r;
        const keep = mix(float(1), person.smoothstep(0.35, 0.75), u.hasMask.mul(u.blur.greaterThan(0.01).select(1, 0)));
        const background = mix(smoothed, mix(smoothed, bg, u.blur), float(1).sub(keep));

        const gain = float(2).pow(u.exposure);
        const wb = vec3(float(1).add(u.warmth.mul(0.08)), float(1), float(1).sub(u.warmth.mul(0.08)));
        const graded = background.mul(gain).mul(wb).clamp(0, 1);

        const material = new THREE.MeshBasicNodeMaterial();
        material.colorNode = vec4(graded, 1);
        material.toneMapped = false;
        material.depthTest = false;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;

        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        this.mesh.renderOrder = -1;
        this.mesh.frustumCulled = false;
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

    /** Person mask in camera space, row 0 = top, values 0..1. Null disables blur masking. */
    setMask(mask: Float32Array | null, width: number, height: number): void {
        if (!mask) {
            this.#u.hasMask.value = 0;
            return;
        }
        const img = this.#mask.image as { data: Float32Array; width: number; height: number };
        if (img.width !== width || img.height !== height) {
            this.#mask.dispose();
            img.data = new Float32Array(width * height);
            img.width = width;
            img.height = height;
        }
        img.data.set(mask);
        this.#mask.needsUpdate = true;
        this.#u.hasMask.value = 1;
    }

    dispose(): void {
        this.#video.dispose();
        this.#mask.dispose();
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}
