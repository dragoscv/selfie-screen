/**
 * Maps between the camera frame and the output frame when the camera image is
 * cropped to fill the output ("cover") and optionally mirrored (selfie view).
 * All coordinates are normalised [0,1] with y down, like MediaPipe landmarks.
 */
export interface Framing {
    /** videoUv = offset + outUv * scale (before mirroring). */
    scaleX: number;
    scaleY: number;
    offsetX: number;
    offsetY: number;
    mirror: boolean;
}

export function coverFraming(videoW: number, videoH: number, outW: number, outH: number, mirror: boolean): Framing {
    const va = videoW / Math.max(videoH, 1);
    const oa = outW / Math.max(outH, 1);
    if (va > oa) {
        const scaleX = oa / va;
        return { scaleX, scaleY: 1, offsetX: (1 - scaleX) / 2, offsetY: 0, mirror };
    }
    const scaleY = va / oa;
    return { scaleX: 1, scaleY, offsetX: 0, offsetY: (1 - scaleY) / 2, mirror };
}

/** Camera-normalised point -> output-normalised point (may fall outside [0,1]). */
export function videoToOutput(f: Framing, x: number, y: number): [number, number] {
    let u = (x - f.offsetX) / f.scaleX;
    if (f.mirror) u = 1 - u;
    return [u, (y - f.offsetY) / f.scaleY];
}

/** Output-normalised point -> camera-normalised point (what the shader samples). */
export function outputToVideo(f: Framing, u: number, v: number): [number, number] {
    const uu = f.mirror ? 1 - u : u;
    return [f.offsetX + uu * f.scaleX, f.offsetY + v * f.scaleY];
}

export interface OutputSize {
    width: number;
    height: number;
}

/** Degrees clockwise to turn the raw camera image so it is upright (camera mounted sideways). */
export type Rotation = 0 | 90 | 180 | 270;

/** Raw camera point -> upright point (normalised, y down). */
export function rawToUpright(r: Rotation, x: number, y: number): [number, number] {
    switch (r) {
        case 90:
            return [1 - y, x];
        case 180:
            return [1 - x, 1 - y];
        case 270:
            return [y, 1 - x];
        default:
            return [x, y];
    }
}

/**
 * Upright -> raw as an affine map raw = (a·u + b·v + c, d·u + e·v + f), for the shader.
 * Inverse of rawToUpright.
 */
export function uprightToRawAffine(r: Rotation): [[number, number, number], [number, number, number]] {
    switch (r) {
        case 90:
            return [[0, 1, 0], [-1, 0, 1]];
        case 180:
            return [[-1, 0, 1], [0, -1, 1]];
        case 270:
            return [[0, -1, 1], [1, 0, 0]];
        default:
            return [[1, 0, 0], [0, 1, 0]];
    }
}

/** Upright frame size for a raw camera size. */
export function uprightSize(r: Rotation, w: number, h: number): [number, number] {
    return r === 90 || r === 270 ? [h, w] : [w, h];
}

/** Q38: portrait 1080x1920 for TikTok, landscape 1920x1080. */
export function outputSize(orientation: "portrait" | "landscape"): OutputSize {
    return orientation === "portrait" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Digital crop on top of a cover framing: `zoom` (>= 1) shrinks the sampled
 * window and (cx, cy) — upright camera coords — is where it is centred. The
 * window is clamped so it never leaves the camera image.
 */
export function cropFraming(base: Framing, zoom: number, cx: number, cy: number): Framing {
    const z = Math.max(1, zoom);
    const scaleX = base.scaleX / z;
    const scaleY = base.scaleY / z;
    return {
        scaleX,
        scaleY,
        offsetX: clamp(cx - scaleX / 2, 0, 1 - scaleX),
        offsetY: clamp(cy - scaleY / 2, 0, 1 - scaleY),
        mirror: base.mirror,
    };
}

/** Centre of the sampled window, upright camera coords. */
export function framingCentre(f: Framing): [number, number] {
    return [f.offsetX + f.scaleX / 2, f.offsetY + f.scaleY / 2];
}

/** Raw camera point -> output-normalised point through rotation and framing. */
export function rawToOutput(f: Framing, r: Rotation, x: number, y: number): [number, number] {
    const [ux, uy] = rawToUpright(r, x, y);
    return videoToOutput(f, ux, uy);
}

/** Make a size NV12-friendly: width a multiple of 4, height a multiple of 2. */
export function evenSize(width: number, height: number): OutputSize {
    return { width: Math.max(4, Math.floor(width / 4) * 4), height: Math.max(2, Math.floor(height / 2) * 2) };
}
