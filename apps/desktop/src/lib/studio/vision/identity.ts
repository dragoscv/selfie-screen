import { ARCFACE_TEMPLATE, IMAGENET_MEAN, IMAGENET_STD, l2normalise, laplacianVariance, rgbaToChw, similarityTransform } from "@tiksee/vision";

import { createSession, inputInfo, runChw, type InputInfo, type Session } from "./onnx.js";

/**
 * Enrolled-identity embeddings (beta). Runs only for matching against
 * enrolled profiles; crops and embeddings of unknown subjects are discarded
 * right after matching and never leave this module.
 *
 * Face: OpenCV-zoo SFace int8, 1x3x112x112. OpenCV's FaceRecognizerSF feeds
 * `blobFromImage(aligned, 1, 112x112, 0, swapRB=true)` on a BGR Mat, so the
 * network actually sees RGB 0..255 — we feed RGB 0..255 to match.
 * Dog: DINOv2-S (q8), pixel_values 1x3x224x224 ImageNet-normalised; embedding
 * = CLS token of last_hidden_state (384-d). Both L2-normalised.
 */

/** Pixel source the crops are drawn from (the frame bitmap). */
export type Source = ImageBitmap | OffscreenCanvas;

export interface FacePoints {
    /** Five points in SOURCE pixels, already ordered like ARCFACE_TEMPLATE (upright image-left eye first). */
    points: [number, number][];
}

export interface Crop {
    rgba: Uint8ClampedArray;
    size: number;
    /** 0..1 sharpness score of the crop. */
    sharpness: number;
}

function ctx2d(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("2d context unavailable");
    return g;
}

function sharpnessOf(rgba: Uint8ClampedArray, size: number): number {
    const gray = new Float32Array(size * size);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * (rgba[i * 4] ?? 0) + 0.587 * (rgba[i * 4 + 1] ?? 0) + 0.114 * (rgba[i * 4 + 2] ?? 0);
    // ~100 is a soft webcam face, ~500+ is crisp.
    return Math.min(1, laplacianVariance(gray, size, size) / 400);
}

/** Similarity-aligned 112x112 face crop (synchronous: safe to call before the bitmap is closed). */
export function alignFace(src: Source, face: FacePoints): Crop {
    const size = 112;
    const c = new OffscreenCanvas(size, size);
    const g = ctx2d(c);
    const t = similarityTransform(face.points, ARCFACE_TEMPLATE);
    g.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty);
    g.drawImage(src, 0, 0);
    const rgba = g.getImageData(0, 0, size, size).data;
    return { rgba, size, sharpness: sharpnessOf(rgba, size) };
}

/** Square crop of a box (source pixels), padded 10 %, resized to `size`. */
export function cropBox(src: Source, box: { x: number; y: number; w: number; h: number }, size = 224): Crop {
    const c = new OffscreenCanvas(size, size);
    const g = ctx2d(c);
    const side = Math.max(box.w, box.h) * 1.1;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    g.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    const rgba = g.getImageData(0, 0, size, size).data;
    return { rgba, size, sharpness: sharpnessOf(rgba, size) };
}

/** 96 px JPEG data URL of a crop, for the enrolment UI only. */
export async function thumbnail(crop: Crop): Promise<string> {
    const c = new OffscreenCanvas(crop.size, crop.size);
    ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(crop.rgba), crop.size, crop.size), 0, 0);
    const t = new OffscreenCanvas(96, 96);
    ctx2d(t).drawImage(c, 0, 0, 96, 96);
    const blob = await t.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
}

export class Embedder {
    #face: { s: Session; info: InputInfo } | null = null;
    #dog: { s: Session; info: InputInfo; out: string } | null = null;

    get hasFace(): boolean {
        return this.#face !== null;
    }

    get hasDog(): boolean {
        return this.#dog !== null;
    }

    async loadFace(model: ArrayBuffer): Promise<void> {
        if (this.#face) return;
        const s = await createSession(model);
        this.#face = { s, info: inputInfo(s) };
    }

    async loadDog(model: ArrayBuffer): Promise<void> {
        if (this.#dog) return;
        const s = await createSession(model);
        this.#dog = { s, info: inputInfo(s), out: s.outputNames.includes("last_hidden_state") ? "last_hidden_state" : (s.outputNames[0] ?? "") };
    }

    async face(crop: Crop): Promise<number[] | null> {
        const f = this.#face;
        if (!f) return null;
        const chw = rgbaToChw(crop.rgba, crop.size, crop.size, { order: "RGB", scale: 1, mean: [0, 0, 0], std: [1, 1, 1] });
        const out = await runChw(f.s, f.info, chw, [1, 3, crop.size, crop.size]);
        const first = Object.values(out)[0];
        return first ? l2normalise(first.data.subarray(0, 128)) : null;
    }

    async dog(crop: Crop): Promise<number[] | null> {
        const d = this.#dog;
        if (!d) return null;
        const chw = rgbaToChw(crop.rgba, crop.size, crop.size, { order: "RGB", scale: 1 / 255, mean: IMAGENET_MEAN, std: IMAGENET_STD });
        const out = await runChw(d.s, d.info, chw, [1, 3, crop.size, crop.size]);
        const t = out[d.out];
        if (!t) return null;
        // last_hidden_state [1, 1 + patches, 384]: CLS = first row. pooler_output [1, 384] works the same way.
        const dim = Number(t.dims[t.dims.length - 1] ?? 384);
        return l2normalise(t.data.subarray(0, dim));
    }

    close(): void {
        void this.#face?.s.release();
        void this.#dog?.s.release();
        this.#face = null;
        this.#dog = null;
    }
}

/** Order the five face points like the ArcFace template, in upright (unmirrored) image terms. */
export function orderFacePoints(
    eyeA: [number, number],
    eyeB: [number, number],
    nose: [number, number],
    mouthA: [number, number],
    mouthB: [number, number],
    uprightX: (p: [number, number]) => number,
): FacePoints {
    const [e1, e2] = uprightX(eyeA) <= uprightX(eyeB) ? [eyeA, eyeB] : [eyeB, eyeA];
    const [m1, m2] = uprightX(mouthA) <= uprightX(mouthB) ? [mouthA, mouthB] : [mouthB, mouthA];
    return { points: [e1, e2, nose, m1, m2] };
}
