import * as THREE from "three/webgpu";
import { abs, dot, exp, float, length, max, mix, positionGeometry, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

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

/**
 * Beauty on the owner's face: strengths 0..1 (shape -1..1), anchors in OUTPUT uv (y down). The
 * region mask (R skin, G eyes / under-eye, B lips, A mouth opening) is an output-space texture.
 */
export interface BackdropBeauty {
    on: number;
    smooth: number;
    even: number;
    brighten: number;
    blush: number;
    eyeBright: number;
    darkCircles: number;
    teeth: number;
    lips: number;
    /** Lip colour, linear-ish RGB 0..1. */
    lipColor: [number, number, number];
    enlarge: number;
    slim: number;
    jaw: number;
    nose: number;
    chin: number;
    anchors: {
        eyeL: [number, number, number];
        eyeR: [number, number, number];
        centre: [number, number];
        faceW: number;
        cheekL: [number, number];
        cheekR: [number, number];
        jawL: [number, number];
        jawR: [number, number];
        nose: [number, number];
        chin: [number, number];
    } | null;
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
        // Beauty.
        bOn: uniform(0),
        bSmooth: uniform(0),
        bEven: uniform(0),
        bBright: uniform(0),
        bBlush: uniform(0),
        bEye: uniform(0),
        bUnder: uniform(0),
        bTeeth: uniform(0),
        bLips: uniform(0),
        bLipColor: uniform(new THREE.Vector3(0.75, 0.2, 0.3)),
        bEnlarge: uniform(0),
        bSlim: uniform(0),
        bJaw: uniform(0),
        bNose: uniform(0),
        bChin: uniform(0),
        /** Eye centres (xy) + radius (z), output uv. */
        eyeL: uniform(new THREE.Vector3(-9, -9, 0.01)),
        eyeR: uniform(new THREE.Vector3(-9, -9, 0.01)),
        /** Face centre (xy) and face width (z). */
        faceC: uniform(new THREE.Vector3(-9, -9, 0.2)),
        cheekL: uniform(new THREE.Vector2(-9, -9)),
        cheekR: uniform(new THREE.Vector2(-9, -9)),
        jawL: uniform(new THREE.Vector2(-9, -9)),
        jawR: uniform(new THREE.Vector2(-9, -9)),
        noseP: uniform(new THREE.Vector2(-9, -9)),
        chinP: uniform(new THREE.Vector2(-9, -9)),
        /** Mask texel (half-res render target). */
        maskTexel: uniform(new THREE.Vector2(1 / 540, 1 / 960)),
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

function emptyRgba(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
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
    readonly #beautyEmpty = emptyRgba();
    /** Every beauty mask tap; `.value` is swapped to the live mask target (no shader rebuild). */
    readonly #maskTaps: THREE.TextureNode[] = [];
    readonly #u = makeUniforms();

    constructor(video: HTMLVideoElement) {
        this.#video = new THREE.VideoTexture(video);
        this.#video.colorSpace = THREE.SRGBColorSpace;
        this.#video.generateMipmaps = false;
        const u = this.#u;

        // Output uv, y down: the plane's uv has v = 1 at the top, so flip it.
        const out = vec2(uv().x, float(1).sub(uv().y));
        // Beauty warps first (where to SAMPLE the camera for this output pixel), then grading.
        const warped = this.#warp(out);
        const [vx, vy] = this.#upright(warped);
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
        const bilateral = sum.div(max(wsum, 1e-4));

        // Blur: a 16-tap ring at two radii, shared by background blur and DoF.
        let bg: Vec3Node = vec3(0);
        const taps = 16;
        for (let i = 0; i < taps; i++) {
            const a = (i / taps) * Math.PI * 2;
            const r = i % 2 === 0 ? 14 : 28;
            bg = bg.add(at(Math.cos(a) * r, Math.sin(a) * r));
        }
        bg = bg.div(taps);

        // --- Beauty: region mask (output space, feathered 5-tap) and per-region grading.
        const mt = u.maskTexel.mul(1.5);
        // Render targets are sampled with y up: flip the output uv (y down).
        const tap = (o: Vec2Node) => {
            const t = texture(this.#beautyEmpty, vec2(o.x, float(1).sub(o.y)));
            this.#maskTaps.push(t);
            return t;
        };
        const mask = tap(out)
            .add(tap(out.add(vec2(mt.x, 0))))
            .add(tap(out.sub(vec2(mt.x, 0))))
            .add(tap(out.add(vec2(0, mt.y))))
            .add(tap(out.sub(vec2(0, mt.y))))
            .div(5);
        const skin: FloatNode = mask.r.mul(u.bOn);
        const eyes: FloatNode = mask.g.mul(float(1).sub(mask.r)).mul(u.bOn);
        const under: FloatNode = mask.g.mul(mask.r).mul(u.bOn);
        // B: lips = 1, mouth opening (teeth) = 0.5, elsewhere 0 (feathered in between).
        const teethM: FloatNode = float(1).sub(abs(mask.b.sub(0.5)).mul(4)).clamp(0, 1).mul(u.bOn);
        const lipsM: FloatNode = mask.b.sub(0.5).mul(2).clamp(0, 1).mul(u.bOn);
        const lumW = vec3(0.2126, 0.7152, 0.0722);
        // Skin smoothing: with beauty on, smoothing is the face skin only (strength bSmooth).
        const smoothAmt: FloatNode = mix(u.smoothing, skin.mul(u.bSmooth), u.bOn);
        let c: Vec3Node = mix(centre, bilateral, smoothAmt);
        // Tone evening: keep the pixel's luminance, take the local average's colour (less redness/blotches).
        const lc = dot(c, lumW);
        const lb = max(dot(bg, lumW), 1e-3);
        const evened = bg.mul(lc.div(lb));
        c = mix(c, evened, skin.mul(u.bEven).mul(0.6));
        c = c.mul(float(1).add(skin.mul(u.bBright).mul(0.22)));
        // Blush: warm rose on the cheeks (skin x falloff around the cheek points).
        const aspectV = vec2(u.aspect, float(1));
        const cheekW = max(this.#falloff(out, u.cheekL, u.faceC.z.mul(0.32), aspectV), this.#falloff(out, u.cheekR, u.faceC.z.mul(0.32), aspectV));
        const blushed = c.mul(vec3(1.06, 0.95, 0.96)).add(vec3(0.035, 0.0, 0.012));
        c = mix(c, blushed, skin.mul(cheekW).mul(u.bBlush));
        // Eyes: brighter and crisper (local contrast vs the blur ring).
        const eyeLift = c.mul(1.12).add(c.sub(bg).mul(0.6));
        c = mix(c, eyeLift, eyes.mul(u.bEye));
        // Under-eye: lift the shadow with a touch of warmth.
        const underLift = c.mul(1.14).add(vec3(0.02, 0.012, 0.0));
        c = mix(c, underLift, under.mul(u.bUnder).mul(0.85));
        // Teeth: only the bright part of the mouth opening, desaturated and lifted.
        const lt = dot(c, lumW);
        const teethW: FloatNode = teethM.mul(lt.smoothstep(0.22, 0.45));
        const white = mix(c, vec3(lt.mul(1.15)), 0.7).add(vec3(-0.008, 0.0, 0.015));
        c = mix(c, white, teethW.mul(u.bTeeth));
        // Lips: colour by luminance-preserving tint.
        const lipTint = u.bLipColor.mul(dot(c, lumW).mul(1.9));
        c = mix(c, lipTint, lipsM.mul(u.bLips).mul(0.55));
        const beautified: Vec3Node = c.clamp(0, 1);
        const base: Vec3Node = mix(smoothed, beautified, u.bOn.greaterThan(0).select(float(1), float(0)));
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
        const background = mix(base, bg, max(blurAmount, dofAmount).clamp(0, 1));

        const gain = float(2).pow(u.exposure);
        const wb = vec3(float(1).add(u.warmth.mul(0.08)), float(1), float(1).sub(u.warmth.mul(0.08)));
        const graded = background.mul(gain).mul(wb).clamp(0, 1);

        const material = new THREE.MeshBasicNodeMaterial();
        // Full-screen in CLIP space, independent of the camera (the stage camera is a
        // perspective camera in metres). Plane [-0.5, 0.5] -> clip [-1, 1]; uv.y=0 is
        // the top row of the output (plane uv v=1 at +y, flipped below).
        material.vertexNode = vec4(positionGeometry.xy.mul(2), 0.999, 1);
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
    /** Smooth bump 1 at `c` -> 0 at radius `r` (aspect-corrected output uv). */
    #falloff(p: Vec2Node, c: Vec2Node, r: FloatNode, aspect: Vec2Node): FloatNode {
        const d = p.sub(c).mul(aspect);
        const t = float(1).sub(d.dot(d).div(max(r.mul(r), 1e-6))).clamp(0, 1);
        return t.mul(t);
    }

    /**
     * Beauty warps in OUTPUT uv: where to sample the camera for the output pixel `p`. Eye enlarge
     * pulls samples toward the eye centre (magnifies); slim/jaw/nose push samples outward from the
     * face centre line (content moves in = narrower); chin pulls content down (longer).
     */
    #warp(p: Vec2Node): Vec2Node {
        const u = this.#u;
        const aspect = vec2(u.aspect, float(1));
        let q: Vec2Node = p;
        for (const eye of [u.eyeL, u.eyeR]) {
            const c = eye.xy;
            const r = eye.z.mul(2.3);
            const w = this.#falloff(p, c, r, aspect);
            q = q.sub(p.sub(c).mul(w.mul(u.bEnlarge).mul(0.28)));
        }
        const fw = u.faceC.z;
        const centre = u.faceC.xy;
        const push = (pt: Vec2Node, radius: FloatNode, amount: FloatNode): Vec2Node => {
            const w = this.#falloff(p, pt, radius, aspect);
            const dir = vec2(pt.x.sub(centre.x), float(0));
            return dir.mul(w.mul(amount));
        };
        q = q.add(push(u.cheekL, fw.mul(0.3), u.bSlim.mul(0.16)));
        q = q.add(push(u.cheekR, fw.mul(0.3), u.bSlim.mul(0.16)));
        q = q.add(push(u.jawL, fw.mul(0.26), u.bJaw.mul(0.18)));
        q = q.add(push(u.jawR, fw.mul(0.26), u.bJaw.mul(0.18)));
        const nw = this.#falloff(p, u.noseP, fw.mul(0.14), aspect);
        q = q.add(vec2(p.x.sub(u.noseP.x).mul(nw.mul(u.bNose).mul(0.35)), float(0)));
        const cw = this.#falloff(p, u.chinP, fw.mul(0.22), aspect);
        q = q.sub(vec2(float(0), cw.mul(u.bChin).mul(fw).mul(0.05)));
        return q;
    }

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

    /**
     * Beauty: uniforms from the settings x anchors, and the live region mask (`null` = none).
     * `maskSize` = mask target size in px (for the feather taps).
     */
    setBeauty(b: BackdropBeauty | null, mask: THREE.Texture | null, maskSize?: { width: number; height: number }): void {
        const u = this.#u;
        const tex = b && b.on > 0 && mask ? mask : this.#beautyEmpty;
        for (const t of this.#maskTaps) if (t.value !== tex) t.value = tex;
        if (maskSize) u.maskTexel.value.set(1 / Math.max(maskSize.width, 1), 1 / Math.max(maskSize.height, 1));
        if (!b || b.on <= 0 || !b.anchors) {
            u.bOn.value = 0;
            u.bEnlarge.value = u.bSlim.value = u.bJaw.value = u.bNose.value = u.bChin.value = 0;
            return;
        }
        u.bOn.value = b.on;
        u.bSmooth.value = b.smooth;
        u.bEven.value = b.even;
        u.bBright.value = b.brighten;
        u.bBlush.value = b.blush;
        u.bEye.value = b.eyeBright;
        u.bUnder.value = b.darkCircles;
        u.bTeeth.value = b.teeth;
        u.bLips.value = b.lips;
        u.bLipColor.value.set(...b.lipColor);
        u.bEnlarge.value = b.enlarge;
        u.bSlim.value = b.slim;
        u.bJaw.value = b.jaw;
        u.bNose.value = b.nose;
        u.bChin.value = b.chin;
        const a = b.anchors;
        u.eyeL.value.set(a.eyeL[0], a.eyeL[1], a.eyeL[2]);
        u.eyeR.value.set(a.eyeR[0], a.eyeR[1], a.eyeR[2]);
        u.faceC.value.set(a.centre[0], a.centre[1], a.faceW);
        u.cheekL.value.set(...a.cheekL);
        u.cheekR.value.set(...a.cheekR);
        u.jawL.value.set(...a.jawL);
        u.jawR.value.set(...a.jawR);
        u.noseP.value.set(...a.nose);
        u.chinP.value.set(...a.chin);
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
        this.#beautyEmpty.dispose();
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}
