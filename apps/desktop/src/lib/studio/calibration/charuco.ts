import { homographyDLT, applyHomography, calibrateIntrinsics, type CalibrationResult, type ViewObservations } from "./zhang.js";
import type { Pt } from "./linalg.js";

/**
 * ChArUco lens calibration for the RAW camera frame.
 *
 * Board: a chessboard whose white squares carry 4×4 ArUco markers
 * (DICT_4X4_50 codes, bit order as js-aruco2 reads them). Square (c, r) is
 * black when c + r is even; markers fill the white squares row-major, so a
 * 5×7 board has 17 markers and 4×6 = 24 inner chessboard corners.
 *
 * Detection: js-aruco2 (MIT, pure JS, lazy-loaded) finds the markers on a
 * downscaled frame; every inner corner is predicted from a local homography
 * of the nearby markers and refined to sub-pixel accuracy on the full-res
 * grey image (gradient-orthogonality, like OpenCV cornerSubPix). The
 * calibration itself is Zhang's method (zhang.ts) with square pixels, no
 * skew and radial k1, k2, refined by Levenberg–Marquardt.
 */

export const CHARUCO_DICTIONARY = "DICT_4X4_50";
/** js-aruco2 dictionary name the codes below are registered under. */
const AR_DICT = "TIKSEE_4X4_50";

/** First 50 codes of OpenCV DICT_4X4_1000 (= DICT_4X4_50), 2 bytes = 16 bits each, row-major MSB first. */
const CODES_4X4_50: readonly (readonly [number, number])[] = [
    [181, 50], [15, 154], [51, 45], [153, 70], [84, 158], [121, 205], [158, 46], [196, 242], [254, 218], [207, 86],
    [249, 145], [17, 167], [14, 183], [42, 15], [36, 177], [38, 62], [70, 101], [102, 0], [108, 94], [118, 175],
    [134, 139], [176, 43], [204, 213], [221, 130], [254, 71], [148, 113], [172, 228], [165, 84], [33, 35], [52, 111],
    [68, 21], [87, 178], [158, 207], [240, 203], [8, 174], [9, 41], [24, 117], [4, 255], [13, 246], [28, 90],
    [23, 24], [42, 40], [50, 140], [56, 178], [36, 232], [46, 235], [45, 63], [75, 100], [80, 46], [80, 19],
];

export function markerBits(id: number): string {
    const c = CODES_4X4_50[id];
    if (!c) throw new Error(`marker id ${id} outside ${CHARUCO_DICTIONARY}`);
    return c[0].toString(2).padStart(8, "0") + c[1].toString(2).padStart(8, "0");
}

export interface BoardSpec {
    squaresX: number;
    squaresY: number;
    /** Marker side / square side. */
    markerRatio: number;
}

export function boardSpec(opts?: { squaresX?: number; squaresY?: number }): BoardSpec {
    const squaresX = Math.max(3, Math.round(opts?.squaresX ?? 5));
    const squaresY = Math.max(3, Math.round(opts?.squaresY ?? 7));
    const spec = { squaresX, squaresY, markerRatio: 0.7 };
    if (markerCount(spec) > CODES_4X4_50.length) throw new Error(`board ${squaresX}x${squaresY} needs more than ${CODES_4X4_50.length} markers`);
    return spec;
}

export function markerCount(spec: BoardSpec): number {
    return Math.floor((spec.squaresX * spec.squaresY) / 2);
}

/** Square (column, row) holding marker `id`, or null. */
export function markerSquare(spec: BoardSpec, id: number): { c: number; r: number } | null {
    if (id < 0 || id >= markerCount(spec)) return null;
    let k = 0;
    for (let r = 0; r < spec.squaresY; r++)
        for (let c = 0; c < spec.squaresX; c++) {
            if ((c + r) % 2 === 0) continue;
            if (k === id) return { c, r };
            k++;
        }
    return null;
}

/** Marker corners on the board (square units, y down) in js-aruco2 order: TL, TR, BR, BL. */
export function markerBoardCorners(spec: BoardSpec, id: number): Pt[] | null {
    const sq = markerSquare(spec, id);
    if (!sq) return null;
    const m = (1 - spec.markerRatio) / 2;
    return [
        { x: sq.c + m, y: sq.r + m },
        { x: sq.c + 1 - m, y: sq.r + m },
        { x: sq.c + 1 - m, y: sq.r + 1 - m },
        { x: sq.c + m, y: sq.r + 1 - m },
    ];
}

/** Inner chessboard corner `id` -> board point (square units). */
export function innerCorner(spec: BoardSpec, id: number): Pt {
    const nx = spec.squaresX - 1;
    return { x: (id % nx) + 1, y: Math.floor(id / nx) + 1 };
}

export function innerCornerCount(spec: BoardSpec): number {
    return (spec.squaresX - 1) * (spec.squaresY - 1);
}

/**
 * Colour of the board at (bx, by) in square units: 0 = black, 255 = white.
 * Outside the board the paper is white.
 */
export function boardLuma(spec: BoardSpec, bx: number, by: number): number {
    if (bx < 0 || by < 0 || bx >= spec.squaresX || by >= spec.squaresY) return 255;
    const c = Math.floor(bx);
    const r = Math.floor(by);
    if ((c + r) % 2 === 0) return 0;
    const id = Math.floor((r * spec.squaresX + c) / 2); // white squares row-major (odd and even squaresX)
    const m = (1 - spec.markerRatio) / 2;
    const fx = (bx - c - m) / spec.markerRatio;
    const fy = (by - r - m) / spec.markerRatio;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return 255;
    const mx = Math.floor(fx * 6);
    const my = Math.floor(fy * 6);
    if (mx === 0 || my === 0 || mx === 5 || my === 5) return 0;
    return markerBits(id)[(my - 1) * 4 + (mx - 1)] === "1" ? 255 : 0;
}

/** A4 at 300 dpi; the board is centred with a 10 mm margin. */
const A4_MM = { w: 210, h: 297 };
const PRINT_DPI = 300;

/**
 * Draw a printable ChArUco board. At 100 % print scale one square is
 * `squareMm` millimetres (the calibration itself is scale-free, so a board
 * shown on a phone screen works too; then the size is unknown -> measure it).
 */
export function renderCharucoBoard(canvas: HTMLCanvasElement, opts?: { squaresX?: number; squaresY?: number }): { squareMm: number | null; dictionary: string } {
    const spec = boardSpec(opts);
    const landscape = spec.squaresX > spec.squaresY;
    const pageW = landscape ? A4_MM.h : A4_MM.w;
    const pageH = landscape ? A4_MM.w : A4_MM.h;
    const squareMm = Math.floor(Math.min((pageW - 20) / spec.squaresX, (pageH - 20) / spec.squaresY));
    const pxPerMm = PRINT_DPI / 25.4;
    canvas.width = Math.round(pageW * pxPerMm);
    canvas.height = Math.round(pageH * pxPerMm);
    const g = canvas.getContext("2d");
    if (!g) return { squareMm: null, dictionary: CHARUCO_DICTIONARY };
    const sq = squareMm * pxPerMm;
    const ox = (canvas.width - sq * spec.squaresX) / 2;
    const oy = (canvas.height - sq * spec.squaresY) / 2;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#000";
    const mod = (sq * spec.markerRatio) / 6;
    const m = (sq * (1 - spec.markerRatio)) / 2;
    let id = 0;
    for (let r = 0; r < spec.squaresY; r++)
        for (let c = 0; c < spec.squaresX; c++) {
            const x = ox + c * sq;
            const y = oy + r * sq;
            if ((c + r) % 2 === 0) {
                g.fillRect(Math.round(x), Math.round(y), Math.round(x + sq) - Math.round(x), Math.round(y + sq) - Math.round(y));
                continue;
            }
            const bits = markerBits(id++);
            for (let my = 0; my < 6; my++)
                for (let mx = 0; mx < 6; mx++) {
                    const border = mx === 0 || my === 0 || mx === 5 || my === 5;
                    if (!border && bits[(my - 1) * 4 + (mx - 1)] === "1") continue;
                    const x0 = Math.round(x + m + mx * mod);
                    const y0 = Math.round(y + m + my * mod);
                    g.fillRect(x0, y0, Math.round(x + m + (mx + 1) * mod) - x0, Math.round(y + m + (my + 1) * mod) - y0);
                }
        }
    g.font = `${Math.round(4 * pxPerMm)}px sans-serif`;
    g.fillText(`TikSee ChArUco ${spec.squaresX}x${spec.squaresY} ${CHARUCO_DICTIONARY} - ${squareMm} mm squares at 100 %`, ox, Math.max(oy - 2 * pxPerMm, 6 * pxPerMm));
    return { squareMm, dictionary: CHARUCO_DICTIONARY };
}

// --- detection ---------------------------------------------------------------------------------

export interface DetectedMarker {
    id: number;
    corners: Pt[];
}

export interface CharucoDetection {
    /** Inner-corner ids (see innerCorner). */
    ids: number[];
    /** Image points (full-res pixels) matching `ids`. */
    image: Pt[];
    markers: number;
}

/** Rec. 601 luma of an RGBA buffer. */
export function rgbaToGrey(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
    return out;
}

/**
 * Sub-pixel corner refinement (OpenCV cornerSubPix): the corner q is where
 * every image gradient in the window is orthogonal to (p - q).
 */
export function cornerSubPix(grey: Float32Array, w: number, h: number, start: Pt, win: number, iterations = 6): Pt | null {
    let q = { ...start };
    const sigma2 = 2 * (win * 0.75) ** 2;
    for (let it = 0; it < iterations; it++) {
        const cx = Math.round(q.x);
        const cy = Math.round(q.y);
        if (cx - win - 1 < 0 || cy - win - 1 < 0 || cx + win + 1 >= w || cy + win + 1 >= h) return null;
        let a = 0;
        let b = 0;
        let c = 0;
        let bx = 0;
        let by = 0;
        for (let y = cy - win; y <= cy + win; y++)
            for (let x = cx - win; x <= cx + win; x++) {
                const gx = (grey[y * w + x + 1]! - grey[y * w + x - 1]!) / 2;
                const gy = (grey[(y + 1) * w + x]! - grey[(y - 1) * w + x]!) / 2;
                const wt = Math.exp(-((x - q.x) ** 2 + (y - q.y) ** 2) / sigma2);
                const gxx = gx * gx * wt;
                const gxy = gx * gy * wt;
                const gyy = gy * gy * wt;
                a += gxx;
                b += gxy;
                c += gyy;
                bx += gxx * x + gxy * y;
                by += gxy * x + gyy * y;
            }
        const det = a * c - b * b;
        if (!(Math.abs(det) > 1e-9)) return null;
        const nx = (c * bx - b * by) / det;
        const ny = (a * by - b * bx) / det;
        const move = Math.hypot(nx - q.x, ny - q.y);
        q = { x: nx, y: ny };
        if (move < 0.01) break;
    }
    if (Math.hypot(q.x - start.x, q.y - start.y) > win) return null;
    return q;
}

/**
 * ChArUco inner corners from decoded markers + the full-res grey image.
 * Markers that disagree with the board-wide homography (bad decodes) are
 * dropped; each corner needs two markers within 1.6 squares.
 */
export function charucoCorners(spec: BoardSpec, markers: readonly DetectedMarker[], grey: Float32Array, w: number, h: number): CharucoDetection {
    const seen = new Map<number, DetectedMarker>();
    for (const m of markers) {
        if (m.corners.length !== 4 || !markerSquare(spec, m.id)) continue;
        if (seen.has(m.id)) seen.delete(m.id); // duplicate id = ambiguous, drop both
        else seen.set(m.id, m);
    }
    const good = [...seen.values()];
    // Iteratively drop the marker that disagrees most with the board-wide homography (bad decodes).
    while (good.length >= 3) {
        const src: Pt[] = [];
        const dst: Pt[] = [];
        for (const m of good) {
            src.push(...markerBoardCorners(spec, m.id)!);
            dst.push(...m.corners);
        }
        const hAll = homographyDLT(src, dst);
        if (!hAll) break;
        let worst = -1;
        let worstErr = 0;
        good.forEach((m, k) => {
            const bc = markerBoardCorners(spec, m.id)!;
            const side = Math.hypot(m.corners[0]!.x - m.corners[1]!.x, m.corners[0]!.y - m.corners[1]!.y) / spec.markerRatio;
            let e = 0;
            bc.forEach((p, i) => {
                const q = applyHomography(hAll, p);
                e = Math.max(e, Math.hypot(q.x - m.corners[i]!.x, q.y - m.corners[i]!.y) / Math.max(side, 1));
            });
            if (e > worstErr) {
                worstErr = e;
                worst = k;
            }
        });
        // Lens distortion bends the board, so allow 0.35 square of disagreement.
        if (worst < 0 || worstErr < 0.35) break;
        good.splice(worst, 1);
    }
    const out: CharucoDetection = { ids: [], image: [], markers: good.length };
    if (good.length < 2) return out;
    const centres = good.map((m) => {
        const sq = markerSquare(spec, m.id)!;
        return { m, cx: sq.c + 0.5, cy: sq.r + 0.5 };
    });
    for (let id = 0; id < innerCornerCount(spec); id++) {
        const bp = innerCorner(spec, id);
        const near = centres.filter((c) => Math.hypot(c.cx - bp.x, c.cy - bp.y) < 1.6);
        if (near.length < 2) continue;
        const src: Pt[] = [];
        const dst: Pt[] = [];
        for (const { m } of near) {
            src.push(...markerBoardCorners(spec, m.id)!);
            dst.push(...m.corners);
        }
        const hl = homographyDLT(src, dst);
        if (!hl) continue;
        const guess = applyHomography(hl, bp);
        const ex = applyHomography(hl, { x: bp.x + 1, y: bp.y });
        const ey = applyHomography(hl, { x: bp.x, y: bp.y + 1 });
        const sqPx = Math.min(Math.hypot(ex.x - guess.x, ex.y - guess.y), Math.hypot(ey.x - guess.x, ey.y - guess.y));
        if (!(sqPx >= 12)) continue;
        // Stay inside the white margin around the corner (0.15 square) so marker edges never enter the window.
        const win = Math.max(2, Math.min(12, Math.floor(0.12 * sqPx)));
        const q = cornerSubPix(grey, w, h, guess, win);
        if (!q || Math.hypot(q.x - guess.x, q.y - guess.y) > Math.max(1.5, 0.08 * sqPx)) continue;
        out.ids.push(id);
        out.image.push(q);
    }
    return out;
}

// --- view selection ----------------------------------------------------------------------------

/** Pose bucket of a view: board-centre cell (3×3), left/right and top/bottom tilt (-1, 0, 1). */
export function viewKey(spec: BoardSpec, det: CharucoDetection, w: number, h: number): { key: string; tilted: boolean; cells: number[] } | null {
    if (det.ids.length < 8) return null;
    const boardPts = det.ids.map((id) => innerCorner(spec, id));
    const cols = new Set(boardPts.map((p) => p.x));
    const rows = new Set(boardPts.map((p) => p.y));
    if (cols.size < 3 || rows.size < 3) return null;
    const hb = homographyDLT(boardPts, det.image);
    if (!hb) return null;
    const [tl, tr, br, bl] = [
        { x: 0, y: 0 },
        { x: spec.squaresX, y: 0 },
        { x: spec.squaresX, y: spec.squaresY },
        { x: 0, y: spec.squaresY },
    ].map((p) => applyHomography(hb, p)) as [Pt, Pt, Pt, Pt];
    const len = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    const q = (v: number) => (v > 0.1 ? 1 : v < -0.1 ? -1 : 0);
    const tx = q(Math.log(len(tr, br) / len(tl, bl)));
    const ty = q(Math.log(len(bl, br) / len(tl, tr)));
    const centre = applyHomography(hb, { x: spec.squaresX / 2, y: spec.squaresY / 2 });
    const cell = (p: Pt) => Math.min(2, Math.max(0, Math.floor((p.x / w) * 3))) + 3 * Math.min(2, Math.max(0, Math.floor((p.y / h) * 3)));
    const cells = [...new Set(det.image.map(cell))];
    return { key: `${cell(centre)}|${tx}|${ty}`, tilted: tx !== 0 || ty !== 0, cells };
}

// --- video loop --------------------------------------------------------------------------------

const NEEDED_VIEWS = 12;
const NEEDED_TILTED = 4;
const MAX_VIEWS = 30;
const SAMPLE_MS = 400;
const DETECT_WIDTH = 960;

interface ArModule {
    DICTIONARIES: Record<string, { nBits: number; tau: number | null; codeList: number[][] }>;
    Detector: new (config?: { dictionaryName?: string; maxHammingDistance?: number }) => { detectImage(w: number, h: number, data: Uint8ClampedArray): { id: number; corners: Pt[] }[] };
}

/**
 * js-aruco2 is CommonJS, patched to `exports.AR` (patches/js-aruco2@2.0.0.patch:
 * upstream writes `this.AR`, which Rolldown compiles to `(void 0).AR`). The
 * dynamic import keeps it in its own lazy chunk.
 */
export async function loadAruco(): Promise<ArModule> {
    const mod = (await import("js-aruco2")) as unknown as { AR?: ArModule; default?: { AR?: ArModule } };
    const ar = mod.AR ?? mod.default?.AR;
    if (!ar) throw new Error("js-aruco2 failed to load");
    if (!ar.DICTIONARIES[AR_DICT]) ar.DICTIONARIES[AR_DICT] = { nBits: 16, tau: null, codeList: CODES_4X4_50.map((c) => [c[0], c[1]]) };
    return ar;
}

/** Marker detector bound to the board dictionary (accepts at most 1 flipped bit). */
export function createMarkerDetector(ar: ArModule): (rgba: Uint8ClampedArray, w: number, h: number) => DetectedMarker[] {
    const det = new ar.Detector({ dictionaryName: AR_DICT, maxHammingDistance: 2 });
    return (rgba, w, h) => det.detectImage(w, h, rgba).map((m) => ({ id: m.id, corners: m.corners.map((p) => ({ x: p.x, y: p.y })) }));
}

/** Detect the board in one RGBA frame; detection runs on a ≤ DETECT_WIDTH copy, refinement at full res. */
export function detectBoard(
    spec: BoardSpec,
    detect: (rgba: Uint8ClampedArray, w: number, h: number) => DetectedMarker[],
    full: { rgba: Uint8ClampedArray; w: number; h: number },
    small?: { rgba: Uint8ClampedArray; w: number; h: number },
): CharucoDetection {
    const s = small ?? full;
    const k = full.w / s.w;
    const markers = detect(s.rgba, s.w, s.h).map((m) => ({ id: m.id, corners: m.corners.map((p) => ({ x: (p.x + 0.5) * k - 0.5, y: (p.y + 0.5) * k - 0.5 })) }));
    return charucoCorners(spec, markers, rgbaToGrey(full.rgba, full.w, full.h), full.w, full.h);
}

function abortError(): DOMException {
    return new DOMException("lens calibration aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        const t = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): Ctx2D {
    if (typeof OffscreenCanvas !== "undefined") {
        const g = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
        if (g) return g;
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("2D canvas unavailable");
    return g;
}

export interface LensCalibration {
    /** Vertical field of view of the raw video frame. */
    vfovDeg: number;
    /** Focal length in raw video pixels. */
    fPx: number;
    k1: number;
    k2: number;
    rmsPx: number;
    views: number;
}

/**
 * Sample the raw camera video every ~400 ms, keep ChArUco views that add a
 * new position / tilt, and calibrate once 12 views (4 tilted) are in.
 */
export async function calibrateLensFromVideo(
    video: HTMLVideoElement,
    onProgress: (p: { views: number; needed: number; lastError?: string; coverage: number }) => void,
    signal: AbortSignal,
): Promise<LensCalibration> {
    const spec = boardSpec();
    const detect = createMarkerDetector(await loadAruco());
    if (signal.aborted) throw abortError();
    const views: ViewObservations[] = [];
    const keys = new Set<string>();
    const cells = new Set<number>();
    let tilted = 0;
    let full: Ctx2D | null = null;
    let small: Ctx2D | null = null;
    const coverage = () => Math.min(1, 0.6 * (cells.size / 9) + 0.4 * Math.min(1, tilted / NEEDED_TILTED));
    const report = (lastError?: string) => onProgress(lastError === undefined ? { views: views.length, needed: NEEDED_VIEWS, coverage: coverage() } : { views: views.length, needed: NEEDED_VIEWS, coverage: coverage(), lastError });
    report();
    const size = { w: 0, h: 0 };
    for (;;) {
        await sleep(SAMPLE_MS, signal);
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h || video.readyState < 2) {
            report("camera not ready");
            continue;
        }
        if (w !== size.w || h !== size.h) {
            // Resolution changed (or first frame): earlier views are in other pixel units.
            views.length = 0;
            keys.clear();
            cells.clear();
            tilted = 0;
            size.w = w;
            size.h = h;
        }
        const sw = Math.min(w, DETECT_WIDTH);
        const sh = Math.round((h * sw) / w);
        if (!full || full.canvas.width !== w || full.canvas.height !== h) full = makeCanvas(w, h);
        if (!small || small.canvas.width !== sw || small.canvas.height !== sh) small = makeCanvas(sw, sh);
        full.drawImage(video, 0, 0, w, h);
        small.drawImage(video, 0, 0, sw, sh);
        const det = detectBoard(spec, detect, { rgba: full.getImageData(0, 0, w, h).data, w, h }, { rgba: small.getImageData(0, 0, sw, sh).data, w: sw, h: sh });
        const vk = viewKey(spec, det, w, h);
        if (!vk) {
            report(det.markers === 0 ? "board not found" : `board partly visible (${det.ids.length} corners)`);
            continue;
        }
        if (keys.has(vk.key)) {
            report(tilted < NEEDED_TILTED ? "move the board elsewhere or tilt it ~30°" : "move the board to a new spot");
            continue;
        }
        keys.add(vk.key);
        if (vk.tilted) tilted++;
        for (const c of vk.cells) cells.add(c);
        views.push({ board: det.ids.map((id) => innerCorner(spec, id)), image: det.image });
        const enough = views.length >= NEEDED_VIEWS && tilted >= NEEDED_TILTED;
        if (enough || views.length >= MAX_VIEWS) break;
        report(views.length >= NEEDED_VIEWS ? "tilt the board left/right and up/down" : undefined);
    }
    const res: CalibrationResult | null = calibrateIntrinsics(views, size.w, size.h);
    if (!res) throw new Error("lens calibration failed: the views did not constrain the camera; tilt the board more");
    onProgress({ views: res.views, needed: NEEDED_VIEWS, coverage: coverage() });
    return { vfovDeg: res.vfovDeg, fPx: res.f, k1: res.k1, k2: res.k2, rmsPx: res.rmsPx, views: res.views };
}
