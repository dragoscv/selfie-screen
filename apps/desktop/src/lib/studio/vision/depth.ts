import { IMAGENET_MEAN, IMAGENET_STD, normaliseDepth, rgbaToChw, uprightMapToRaw, type Rotation } from "@tiksee/vision";

import { createSession, inputInfo, runChw, type InputInfo, type Session } from "./onnx.js";

/**
 * Optional monocular depth (settings.depth === "model"): Depth Anything V2
 * Small fp16 on the WebGPU EP. Input: the UPRIGHT frame resized so the short
 * edge is 252 px and both sides are multiples of 14 (ViT patch), ImageNet
 * normalised. Output: relative inverse depth (bigger = nearer), normalised to
 * 0..1 and rotated back to RAW camera orientation for VisionFrame.depth.
 */
const SHORT_EDGE = 252;
const PATCH = 14;

export function depthInputSize(uprightW: number, uprightH: number): [number, number] {
    const s = SHORT_EDGE / Math.min(uprightW, uprightH);
    const snap = (v: number) => Math.max(PATCH, Math.round((v * s) / PATCH) * PATCH);
    return [snap(uprightW), snap(uprightH)];
}

export class DepthModel {
    #s: Session | null = null;
    #info: InputInfo | null = null;
    #canvas: OffscreenCanvas | null = null;

    get loaded(): boolean {
        return this.#s !== null;
    }

    async load(model: ArrayBuffer): Promise<void> {
        if (this.#s) return;
        this.#s = await createSession(model);
        this.#info = inputInfo(this.#s);
    }

    /**
     * Draws the frame upright into the model canvas synchronously (so the caller
     * may close the bitmap right after) and returns the inference promise.
     */
    run(src: ImageBitmap, rotation: Rotation): Promise<{ data: Float32Array; width: number; height: number }> | null {
        const s = this.#s;
        const info = this.#info;
        if (!s || !info) return null;
        const upW = rotation === 90 || rotation === 270 ? src.height : src.width;
        const upH = rotation === 90 || rotation === 270 ? src.width : src.height;
        const [w, h] = depthInputSize(upW, upH);
        if (!this.#canvas || this.#canvas.width !== w || this.#canvas.height !== h) this.#canvas = new OffscreenCanvas(w, h);
        const g = this.#canvas.getContext("2d", { willReadFrequently: true });
        if (!g) return null;
        g.setTransform(1, 0, 0, 1, 0, 0);
        // Turn raw -> upright: rotate the canvas clockwise by `rotation` around its centre.
        g.translate(w / 2, h / 2);
        g.rotate((rotation * Math.PI) / 180);
        const rw = rotation === 90 || rotation === 270 ? h : w;
        const rh = rotation === 90 || rotation === 270 ? w : h;
        g.drawImage(src, -rw / 2, -rh / 2, rw, rh);
        const rgba = g.getImageData(0, 0, w, h).data;
        const chw = rgbaToChw(rgba, w, h, { order: "RGB", scale: 1 / 255, mean: IMAGENET_MEAN, std: IMAGENET_STD });
        return runChw(s, info, chw, [1, 3, h, w]).then((out) => {
            const t = Object.values(out)[0];
            if (!t) throw new Error("depth model returned no output");
            // [1, H, W] or [1, 1, H, W]
            const oh = Number(t.dims[t.dims.length - 2] ?? h);
            const ow = Number(t.dims[t.dims.length - 1] ?? w);
            const n = normaliseDepth({ data: t.data, width: ow, height: oh });
            return uprightMapToRaw(n.data, n.width, n.height, rotation);
        });
    }

    close(): void {
        void this.#s?.release();
        this.#s = null;
        this.#info = null;
    }
}
