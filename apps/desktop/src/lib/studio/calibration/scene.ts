import { mulberry32, symEigen } from "./linalg.js";

/**
 * One-time scene analysis with Microsoft MoGe-2 ViT-S (normal) — MIT.
 *
 * The ONNX graph (official export, Ruicheng/moge-2-vits-normal-onnx) only
 * runs forward(): inputs `image` [1,3,H,W] float32 RGB in 0..1 (ImageNet
 * normalisation happens inside) and `num_tokens` int64 scalar; outputs
 * `points` [1,H,W,3] affine-invariant point map, `normal` [1,H,W,3],
 * `mask` [1,H,W] (sigmoid) and `scale` [1] (metric scale, exp applied).
 * The post-processing of MoGe's `infer()` is ported here: recover focal +
 * z-shift from the point map (utils.recover_focal_shift), re-project the
 * depth with the recovered intrinsics, apply the metric scale. Planes are
 * then found by RANSAC in a room frame built from the user's camera
 * height and tilt.
 */

// --- model asset -------------------------------------------------------------------------------

/** Upstream file, pinned to the HF commit; sha256 = the git-LFS oid (verified via the HF API, 2026-10-06). */
export const SCENE_MODEL = {
    name: "moge-2-vits-normal.onnx",
    bytes: 140_852_051,
    sha256: "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0",
    /** Mirror in the release bucket (allowed by the app CSP). Upload the upstream file here unchanged. */
    mirror: "https://storage.googleapis.com/tiksee-releases/models/moge-2-vits-normal.onnx",
    /** Upstream (redirects to the HF xet CDN — not in the app CSP, works in dev / browsers only). */
    upstream: "https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx/resolve/e50ffda41565591092adea54c6ac83d6212e1e23/model.onnx",
} as const;

const CACHE = "tiksee-models-v1";
const NUM_TOKENS = 2400;
const INPUT_LONG_EDGE = 512;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchExact(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const out = new Uint8Array(SCENE_MODEL.bytes);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > out.length) {
            await reader.cancel();
            throw new Error("larger than expected");
        }
        out.set(value, got);
        got += value.length;
        onBytes(got);
    }
    if (got !== out.length) throw new Error(`got ${got} of ${out.length} bytes`);
    return out.buffer;
}

/** Cache-first, sha256-verified download (mirror, then upstream). Throws "scene model unavailable: …". */
export async function loadSceneModel(onBytes: (n: number) => void = () => {}): Promise<ArrayBuffer> {
    const cache = await caches.open(CACHE);
    const key = SCENE_MODEL.mirror;
    const hit = await cache.match(key);
    if (hit) {
        const buf = await hit.arrayBuffer();
        if ((await sha256Hex(buf)) === SCENE_MODEL.sha256) {
            onBytes(SCENE_MODEL.bytes);
            return buf;
        }
        await cache.delete(key);
    }
    const errors: string[] = [];
    for (const url of [SCENE_MODEL.mirror, SCENE_MODEL.upstream]) {
        try {
            const buf = await fetchExact(url, onBytes);
            const hash = await sha256Hex(buf);
            if (hash !== SCENE_MODEL.sha256) throw new Error(`sha256 ${hash.slice(0, 12)}… != ${SCENE_MODEL.sha256.slice(0, 12)}…`);
            await cache.put(key, new Response(buf, { headers: { "content-type": "application/octet-stream", "content-length": String(SCENE_MODEL.bytes) } }));
            return buf;
        } catch (e) {
            errors.push(`${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
            onBytes(0);
        }
    }
    throw new Error(`scene model unavailable: ${errors.join("; ")}`);
}

// --- MoGe post-processing (pure) ---------------------------------------------------------------

/**
 * MoGe normalized view-plane UV for pixel centres: x spans ±(w/diag)·(w-1)/w,
 * y spans ±(h/diag)·(h-1)/h. Interleaved [u, v] per pixel, row-major.
 */
export function normalizedViewPlaneUv(width: number, height: number): Float32Array {
    const ar = width / height;
    const sx = ar / Math.sqrt(1 + ar * ar);
    const sy = 1 / Math.sqrt(1 + ar * ar);
    const out = new Float32Array(width * height * 2);
    const ux = width > 1 ? (2 * sx * ((width - 1) / width)) / (width - 1) : 0;
    const vy = height > 1 ? (2 * sy * ((height - 1) / height)) / (height - 1) : 0;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = 2 * (y * width + x);
            out[i] = -sx * ((width - 1) / width) + x * ux;
            out[i + 1] = -sy * ((height - 1) / height) + y * vy;
        }
    return out;
}

/** Nearest-neighbour index of torch F.interpolate(mode="nearest"). */
function nearestIdx(i: number, outSize: number, inSize: number): number {
    return Math.min(inSize - 1, Math.floor((i * inSize) / outSize));
}

/**
 * Port of MoGe `recover_focal_shift` (+ numpy `solve_optimal_focal_shift`):
 * minimise |focal·xy/(z+shift) − uv| over shift (focal in closed form) on a
 * 64×64 nearest-downsampled map. Focal is relative to half the image
 * diagonal. Points: [H, W, 3] interleaved; mask: optional per-pixel 0..1.
 */
export function recoverFocalShift(points: ArrayLike<number>, width: number, height: number, mask?: ArrayLike<number> | null, size = 64): { focal: number; shift: number } {
    const uvFull = normalizedViewPlaneUv(width, height);
    const uv: number[] = [];
    const xyz: number[] = [];
    for (let oy = 0; oy < size; oy++) {
        const y = nearestIdx(oy, size, height);
        for (let ox = 0; ox < size; ox++) {
            const x = nearestIdx(ox, size, width);
            const p = y * width + x;
            if (mask && !(mask[p]! > 0.5)) continue;
            const X = points[3 * p]!;
            const Y = points[3 * p + 1]!;
            const Z = points[3 * p + 2]!;
            if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) continue;
            uv.push(uvFull[2 * p]!, uvFull[2 * p + 1]!);
            xyz.push(X, Y, Z);
        }
    }
    const n = uv.length / 2;
    if (n < 2) return { focal: 1, shift: 0 };
    const focalFor = (shift: number) => {
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
            const z = xyz[3 * i + 2]! + shift;
            const px = xyz[3 * i]! / z;
            const py = xyz[3 * i + 1]! / z;
            num += px * uv[2 * i]! + py * uv[2 * i + 1]!;
            den += px * px + py * py;
        }
        return num / den;
    };
    const residual = (shift: number, out: Float64Array) => {
        const f = focalFor(shift);
        for (let i = 0; i < n; i++) {
            const z = xyz[3 * i + 2]! + shift;
            out[2 * i] = (f * xyz[3 * i]!) / z - uv[2 * i]!;
            out[2 * i + 1] = (f * xyz[3 * i + 1]!) / z - uv[2 * i + 1]!;
        }
    };
    const sq = (r: Float64Array) => r.reduce((s, v) => s + v * v, 0);
    // Scalar Levenberg–Marquardt from shift = 0 (same start as MoGe's least_squares).
    const r = new Float64Array(2 * n);
    const r2 = new Float64Array(2 * n);
    let shift = 0;
    residual(shift, r);
    let cost = sq(r);
    let lambda = 1e-3;
    const zMin = xyz.reduce((m, v, i) => (i % 3 === 2 ? Math.min(m, v) : m), Infinity);
    for (let it = 0; it < 100; it++) {
        const h = 1e-6 * Math.max(1, Math.abs(shift));
        residual(shift + h, r2);
        let jtj = 0;
        let jtr = 0;
        for (let i = 0; i < r.length; i++) {
            const j = (r2[i]! - r[i]!) / h;
            jtj += j * j;
            jtr += j * r[i]!;
        }
        let stepped = false;
        for (let k = 0; k < 20; k++) {
            const next = shift - jtr / (jtj * (1 + lambda) + 1e-30);
            if (next + zMin > 1e-6) {
                residual(next, r2);
                const c2 = sq(r2);
                if (c2 < cost) {
                    const rel = (cost - c2) / Math.max(cost, 1e-30);
                    shift = next;
                    r.set(r2);
                    cost = c2;
                    lambda = Math.max(lambda / 10, 1e-12);
                    stepped = true;
                    if (rel < 1e-9) it = 100;
                    break;
                }
            }
            lambda *= 10;
        }
        if (!stepped) break;
    }
    return { focal: focalFor(shift), shift };
}

/** Normalised intrinsics (fx relative to width, fy to height) from MoGe's half-diagonal focal. */
export function focalToIntrinsics(focal: number, width: number, height: number): { fx: number; fy: number } {
    const ar = width / height;
    const diag = Math.sqrt(1 + ar * ar);
    return { fx: ((focal / 2) * diag) / ar, fy: (focal / 2) * diag };
}

export function vfovFromNormalisedFy(fy: number): number {
    return (2 * Math.atan(0.5 / fy) * 180) / Math.PI;
}

/**
 * Metric camera-space point map (OpenCV axes: x right, y down, z forward)
 * from the raw MoGe outputs. Invalid pixels are NaN.
 */
export function metricPointMap(
    points: ArrayLike<number>,
    mask: ArrayLike<number> | null,
    metricScale: number,
    width: number,
    height: number,
): { xyz: Float32Array; vfovDeg: number; valid: number } {
    const { focal, shift } = recoverFocalShift(points, width, height, mask);
    const { fx, fy } = focalToIntrinsics(focal, width, height);
    const xyz = new Float32Array(width * height * 3).fill(Number.NaN);
    let valid = 0;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const p = y * width + x;
            if (mask && !(mask[p]! > 0.5)) continue;
            const z = points[3 * p + 2]! + shift;
            if (!(z > 0) || !Number.isFinite(z)) continue;
            const d = z * metricScale;
            // utils3d depth_map_to_point_map: pixel-centre uv in 0..1, principal point 0.5.
            xyz[3 * p] = (((x + 0.5) / width - 0.5) / fx) * d;
            xyz[3 * p + 1] = (((y + 0.5) / height - 0.5) / fy) * d;
            xyz[3 * p + 2] = d;
            valid++;
        }
    return { xyz, vfovDeg: vfovFromNormalisedFy(fy), valid };
}

// --- room frame + planes (pure) ----------------------------------------------------------------

/**
 * Camera (OpenCV axes) -> room (x right, y up from the floor, z forward
 * horizontal). The camera sits at `heightM`, pitched DOWN by `tiltDeg`.
 */
export function cameraToRoom(xc: number, yc: number, zc: number, tiltDeg: number, heightM: number): [number, number, number] {
    const t = (tiltDeg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [xc, heightM - (yc * c + zc * s), zc * c - yc * s];
}

/** Inverse of cameraToRoom (used by the tests to synthesise scenes). */
export function roomToCamera(x: number, y: number, z: number, tiltDeg: number, heightM: number): [number, number, number] {
    const t = (tiltDeg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const a = heightM - y; // = yc c + zc s
    return [x, a * c - z * s, a * s + z * c];
}

export interface Plane {
    /** Unit normal (room frame). */
    n: [number, number, number];
    /** Plane: n·p = d. */
    d: number;
    inliers: number;
}

/** Least-squares plane through points (PCA). */
export function fitPlane(pts: ArrayLike<number>, idx: readonly number[]): { n: [number, number, number]; d: number } | null {
    if (idx.length < 3) return null;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const i of idx) {
        mx += pts[3 * i]!;
        my += pts[3 * i + 1]!;
        mz += pts[3 * i + 2]!;
    }
    mx /= idx.length;
    my /= idx.length;
    mz /= idx.length;
    const c = new Float64Array(9);
    for (const i of idx) {
        const dx = pts[3 * i]! - mx;
        const dy = pts[3 * i + 1]! - my;
        const dz = pts[3 * i + 2]! - mz;
        c[0] = c[0]! + dx * dx;
        c[1] = c[1]! + dx * dy;
        c[2] = c[2]! + dx * dz;
        c[4] = c[4]! + dy * dy;
        c[5] = c[5]! + dy * dz;
        c[8] = c[8]! + dz * dz;
    }
    c[3] = c[1]!;
    c[6] = c[2]!;
    c[7] = c[5]!;
    const { vectors } = symEigen(c, 3);
    const n: [number, number, number] = [vectors[0]!, vectors[3]!, vectors[6]!];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) return null;
    n[0] /= len;
    n[1] /= len;
    n[2] /= len;
    return { n, d: n[0] * mx + n[1] * my + n[2] * mz };
}

export interface RansacOptions {
    iterations?: number;
    /** Inlier distance (m). */
    threshold?: number;
    /** Accept a candidate normal (unit, room frame). */
    accept?: (n: [number, number, number]) => boolean;
    seed?: number;
}

/** RANSAC plane over the listed point indices (xyz triplets), refined by LS on the inliers. */
export function ransacPlane(pts: ArrayLike<number>, candidates: readonly number[], opts: RansacOptions = {}): Plane | null {
    const iters = opts.iterations ?? 400;
    const thr = opts.threshold ?? 0.02;
    const rand = mulberry32(opts.seed ?? 1);
    const m = candidates.length;
    if (m < 3) return null;
    let best: { n: [number, number, number]; d: number; count: number } | null = null;
    const countFor = (n: readonly number[], d: number) => {
        let k = 0;
        for (const i of candidates) if (Math.abs(n[0]! * pts[3 * i]! + n[1]! * pts[3 * i + 1]! + n[2]! * pts[3 * i + 2]! - d) <= thr) k++;
        return k;
    };
    for (let it = 0; it < iters; it++) {
        const a = candidates[Math.floor(rand() * m)]!;
        const b = candidates[Math.floor(rand() * m)]!;
        const c = candidates[Math.floor(rand() * m)]!;
        if (a === b || b === c || a === c) continue;
        const ux = pts[3 * b]! - pts[3 * a]!;
        const uy = pts[3 * b + 1]! - pts[3 * a + 1]!;
        const uz = pts[3 * b + 2]! - pts[3 * a + 2]!;
        const vx = pts[3 * c]! - pts[3 * a]!;
        const vy = pts[3 * c + 1]! - pts[3 * a + 1]!;
        const vz = pts[3 * c + 2]! - pts[3 * a + 2]!;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        nx /= len;
        ny /= len;
        nz /= len;
        const n: [number, number, number] = [nx, ny, nz];
        if (opts.accept && !opts.accept(n) && !opts.accept([-nx, -ny, -nz])) continue;
        const d = nx * pts[3 * a]! + ny * pts[3 * a + 1]! + nz * pts[3 * a + 2]!;
        const count = countFor(n, d);
        if (!best || count > best.count) best = { n, d, count };
    }
    if (!best) return null;
    // Two LS refinements on the inlier set.
    let plane = { n: best.n, d: best.d };
    for (let r = 0; r < 2; r++) {
        const inl = candidates.filter((i) => Math.abs(plane.n[0] * pts[3 * i]! + plane.n[1] * pts[3 * i + 1]! + plane.n[2] * pts[3 * i + 2]! - plane.d) <= thr);
        const ls = fitPlane(pts, inl);
        if (!ls || (opts.accept && !opts.accept(ls.n) && !opts.accept([-ls.n[0], -ls.n[1], -ls.n[2]]))) break;
        plane = ls;
    }
    const count = candidates.filter((i) => Math.abs(plane.n[0] * pts[3 * i]! + plane.n[1] * pts[3 * i + 1]! + plane.n[2] * pts[3 * i + 2]! - plane.d) <= thr).length;
    return { n: plane.n, d: plane.d, inliers: count };
}

export interface RoomPlanes {
    deskHeightM?: number;
    wallDistanceM?: number;
}

const DEG = Math.PI / 180;

/**
 * A real surface keeps most of its neighbourhood inside the thin band; a
 * horizontal slice through a slanted surface does not (inliers ≈ thin/thick).
 */
function isFlat(room: ArrayLike<number>, cand: readonly number[], p: Plane, thin: number, thick: number): boolean {
    let a = 0;
    let b = 0;
    for (const i of cand) {
        const e = Math.abs(p.n[0] * room[3 * i]! + p.n[1] * room[3 * i + 1]! + p.n[2] * room[3 * i + 2]! - p.d);
        if (e <= thin) a++;
        if (e <= thick) b++;
    }
    return b > 0 && a / b >= 0.6;
}

/**
 * Desk = largest horizontal plane 0.5–1.1 m above the floor in front of the
 * camera; wall = largest vertical plane facing the camera beyond 1 m.
 * Points: room-frame xyz triplets (NaN = invalid). Wall distance is the
 * horizontal perpendicular distance from the camera to the wall plane.
 */
export function findRoomPlanes(room: ArrayLike<number>, opts: { cameraHeightM: number; minInlierFraction?: number; seed?: number }): RoomPlanes {
    const count = Math.floor(room.length / 3);
    const valid: number[] = [];
    for (let i = 0; i < count; i++) if (Number.isFinite(room[3 * i]!) && Number.isFinite(room[3 * i + 1]!) && Number.isFinite(room[3 * i + 2]!)) valid.push(i);
    const minIn = Math.max(50, Math.round((opts.minInlierFraction ?? 0.02) * valid.length));
    const out: RoomPlanes = {};
    // Desk: band 0.45–1.15 m, in front (z > 0.2 m). Normal within 12° of vertical.
    const deskCand = valid.filter((i) => room[3 * i + 1]! > 0.45 && room[3 * i + 1]! < 1.15 && room[3 * i + 2]! > 0.2);
    const desk = ransacPlane(room, deskCand, { threshold: 0.015, accept: (n) => n[1] > Math.cos(12 * DEG), seed: opts.seed ?? 7 });
    if (desk && desk.inliers >= minIn && isFlat(room, deskCand, desk, 0.015, 0.1)) {
        // Height of the plane straight below/above the camera (x = z = 0).
        const h = desk.d / desk.n[1];
        if (h >= 0.5 && h <= 1.1) out.deskHeightM = h;
    }
    // Wall: z > 1 m, normal within 12° of horizontal and within 40° of the view axis.
    const wallCand = valid.filter((i) => room[3 * i + 2]! > 1);
    const wall = ransacPlane(room, wallCand, {
        threshold: 0.03,
        accept: (n) => Math.abs(n[1]) < Math.sin(12 * DEG) && n[2] > Math.cos(40 * DEG),
        seed: (opts.seed ?? 7) + 1,
    });
    if (wall && wall.inliers >= minIn && isFlat(room, wallCand, wall, 0.03, 0.2)) {
        // Camera at c = (0, h, 0); horizontal distance to the plane along its horizontal normal.
        const hn = Math.hypot(wall.n[0], wall.n[2]);
        const dist = Math.abs(wall.n[1] * opts.cameraHeightM - wall.d) / hn;
        if (dist > 1) out.wallDistanceM = dist;
    }
    return out;
}

/** Camera-space point map -> room-frame points, subsampled to ≤ maxPoints (stride). */
export function pointMapToRoom(xyz: ArrayLike<number>, tiltDeg: number, cameraHeightM: number, maxPoints = 30_000): Float32Array {
    const n = Math.floor(xyz.length / 3);
    const stride = Math.max(1, Math.ceil(n / maxPoints));
    const out = new Float32Array(Math.ceil(n / stride) * 3).fill(Number.NaN);
    for (let i = 0, o = 0; i < n; i += stride, o++) {
        const x = xyz[3 * i]!;
        if (!Number.isFinite(x)) continue;
        const r = cameraToRoom(x, xyz[3 * i + 1]!, xyz[3 * i + 2]!, tiltDeg, cameraHeightM);
        out[3 * o] = r[0];
        out[3 * o + 1] = r[1];
        out[3 * o + 2] = r[2];
    }
    return out;
}

// --- inference ---------------------------------------------------------------------------------

export function sceneInputSize(w: number, h: number): [number, number] {
    const s = INPUT_LONG_EDGE / Math.max(w, h);
    return [Math.max(14, Math.round(w * s)), Math.max(14, Math.round(h * s))];
}

export interface SceneAnalysis {
    vfovDeg: number;
    deskHeightM?: number;
    wallDistanceM?: number;
    ms: number;
}

/**
 * Download (first time, ~141 MB, cached) and run MoGe-2 once on the current
 * raw camera frame. The camera is assumed mounted upright (raw = upright);
 * vFOV is for the raw video height. Progress: 0..0.85 download, then inference.
 */
export async function analyseSceneFromVideo(
    video: HTMLVideoElement,
    onProgress: (p: number) => void,
    opts: { tiltDeg: number; cameraHeightM: number },
): Promise<SceneAnalysis> {
    const t0 = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error("camera not ready");
    const [w, h] = sceneInputSize(vw, vh);
    // Grab the frame first so the scene the user sees is the one analysed.
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const g = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) throw new Error("2D canvas unavailable");
    g.drawImage(video, 0, 0, w, h);
    const rgba = g.getImageData(0, 0, w, h).data;
    const chw = new Float32Array(3 * w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        chw[i] = rgba[p]! / 255;
        chw[w * h + i] = rgba[p + 1]! / 255;
        chw[2 * w * h + i] = rgba[p + 2]! / 255;
    }
    onProgress(0);
    const model = await loadSceneModel((n) => onProgress(0.85 * (n / SCENE_MODEL.bytes)));
    onProgress(0.86);
    const [{ createSession }, ort] = await Promise.all([import("../vision/onnx.js"), import("onnxruntime-web")]);
    const session = await createSession(model);
    try {
        onProgress(0.9);
        const image = new ort.Tensor("float32", chw, [1, 3, h, w]);
        const tokens = new ort.Tensor("int64", BigInt64Array.from([BigInt(NUM_TOKENS)]), []);
        const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {};
        for (const name of session.inputNames) feeds[name] = name === "num_tokens" ? tokens : image;
        const out = await session.run(feeds);
        const read = (k: string): Float32Array | null => {
            const t = out[k];
            if (!t) return null;
            const d = t.data;
            return d instanceof Float32Array ? d : Float32Array.from(d as ArrayLike<number>, Number);
        };
        const points = read("points");
        const mask = read("mask");
        const scale = read("scale") ?? read("metric_scale");
        for (const t of Object.values(out)) t.dispose();
        image.dispose();
        tokens.dispose();
        if (!points || points.length !== w * h * 3) throw new Error("scene model returned no point map");
        onProgress(0.95);
        const metric = scale?.[0] ?? 1;
        const map = metricPointMap(points, mask, metric, w, h);
        if (map.valid < 1000) throw new Error("scene analysis: too few valid pixels (point the camera at the room)");
        const planes = findRoomPlanes(pointMapToRoom(map.xyz, opts.tiltDeg, opts.cameraHeightM), { cameraHeightM: opts.cameraHeightM });
        onProgress(1);
        return { vfovDeg: map.vfovDeg, ...planes, ms: Math.round(performance.now() - t0) };
    } finally {
        void session.release();
    }
}
