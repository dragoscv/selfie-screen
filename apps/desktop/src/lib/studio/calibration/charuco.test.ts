import { describe, expect, it } from "vitest";

import {
    boardLuma,
    boardSpec,
    charucoCorners,
    cornerSubPix,
    createMarkerDetector,
    detectBoard,
    innerCorner,
    innerCornerCount,
    loadAruco,
    markerBits,
    markerBoardCorners,
    markerCount,
    markerSquare,
    type DetectedMarker,
} from "./charuco.js";
import { gaussian, mulberry32, rodrigues, type Pt } from "./linalg.js";
import { applyHomography, calibrateIntrinsics, focalFromHomographies, focalFromVfov, homographyDLT, projectPoint, vfovFromFocal, type Intrinsics, type ViewObservations } from "./zhang.js";

const W = 1920;
const H = 1080;
const CAM: Intrinsics = { f: 1400, cx: 958.3, cy: 543.1, k1: -0.12, k2: 0.03 };

/** Board 5×7 inner corners in metres (30 mm squares). */
function boardPoints(): Pt[] {
    const spec = boardSpec();
    return Array.from({ length: innerCornerCount(spec) }, (_, id) => {
        const p = innerCorner(spec, id);
        return { x: p.x * 0.03, y: p.y * 0.03 };
    });
}

/** Pose looking at the board centre from ~`dist` m, with tilt (rx, ry) and in-plane rz. */
function pose(rx: number, ry: number, rz: number, ox: number, oy: number, dist: number): { r: number[]; t: number[] } {
    const r = [rx, ry, rz];
    const R = rodrigues(rx, ry, rz);
    const c = { x: 0.075, y: 0.105 };
    // t chosen so the board centre lands at (ox, oy, dist) in camera space.
    const t = [ox - (R[0]! * c.x + R[1]! * c.y), oy - (R[3]! * c.x + R[4]! * c.y), dist - (R[6]! * c.x + R[7]! * c.y)];
    return { r, t };
}

const POSES = [
    pose(0.0, 0.0, 0.05, 0, 0, 0.8),
    pose(0.45, 0.0, 0.1, -0.12, -0.06, 0.8),
    pose(-0.45, 0.05, -0.1, 0.12, 0.06, 0.8),
    pose(0.0, 0.5, 0.2, 0.2, -0.04, 0.85),
    pose(0.05, -0.5, -0.2, -0.2, 0.04, 0.85),
    pose(0.35, 0.35, 0.0, -0.25, 0.1, 0.8),
    pose(-0.35, -0.35, 0.3, 0.25, -0.1, 0.8),
    pose(0.3, -0.3, -0.3, 0.25, 0.1, 0.75),
    pose(-0.3, 0.3, 1.2, -0.25, -0.1, 0.75),
    pose(0.2, 0.0, 1.57, 0.3, 0.0, 0.9),
    pose(0.0, 0.25, -1.4, -0.3, 0.0, 0.9),
    pose(0.15, 0.15, 0.6, 0, 0.08, 0.7),
];

function synthViews(noisePx: number, seed = 3): ViewObservations[] {
    const rand = mulberry32(seed);
    const board = boardPoints();
    return POSES.map((p) => {
        const image = board.map((b) => {
            const q = projectPoint(CAM, p.r, p.t, b);
            return { x: q.x + noisePx * gaussian(rand), y: q.y + noisePx * gaussian(rand) };
        });
        for (const q of image) {
            expect(q.x).toBeGreaterThan(0);
            expect(q.x).toBeLessThan(W);
            expect(q.y).toBeGreaterThan(0);
            expect(q.y).toBeLessThan(H);
        }
        return { board, image };
    });
}

describe("homographyDLT", () => {
    it("recovers a known homography exactly", () => {
        const Ht = [1.2, 0.1, 30, -0.05, 0.9, 12, 1e-4, -2e-4, 1];
        const src = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 80 },
            { x: 0, y: 80 },
            { x: 50, y: 40 },
            { x: 20, y: 70 },
        ];
        const dst = src.map((p) => applyHomography(Ht, p));
        const h = homographyDLT(src, dst)!;
        for (const p of [{ x: 33, y: 17 }, { x: 77, y: 64 }]) {
            const a = applyHomography(h, p);
            const b = applyHomography(Ht, p);
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
        }
    });

    it("returns null for fewer than 4 points", () => {
        expect(homographyDLT([{ x: 0, y: 0 }], [{ x: 0, y: 0 }])).toBeNull();
    });
});

describe("Zhang calibration", () => {
    it("closed-form focal from noiseless homographies (no distortion) is exact", () => {
        const cam = { ...CAM, k1: 0, k2: 0 };
        const board = boardPoints();
        const hs = POSES.map((p) => homographyDLT(board, board.map((b) => projectPoint(cam, p.r, p.t, b)))!);
        const f = focalFromHomographies(hs, cam.cx, cam.cy)!;
        expect(Math.abs(f - cam.f) / cam.f).toBeLessThan(1e-6);
    });

    it("recovers f within 1 % (and k1, k2, principal point) from 12 views with 0.3 px noise", () => {
        const res = calibrateIntrinsics(synthViews(0.3), W, H)!;
        expect(res).not.toBeNull();
        expect(Math.abs(res.f - CAM.f) / CAM.f).toBeLessThan(0.01);
        expect(Math.abs(res.vfovDeg - vfovFromFocal(CAM.f, H))).toBeLessThan(0.3);
        expect(Math.abs(res.k1 - CAM.k1)).toBeLessThan(0.03);
        expect(Math.abs(res.cx - CAM.cx)).toBeLessThan(8);
        expect(Math.abs(res.cy - CAM.cy)).toBeLessThan(8);
        expect(res.rmsPx).toBeGreaterThan(0.2);
        expect(res.rmsPx).toBeLessThan(0.45);
        expect(res.views).toBe(12);
    });

    it("survives a few gross outliers", () => {
        const views = synthViews(0.3, 9);
        views[2]!.image[5] = { x: views[2]!.image[5]!.x + 25, y: views[2]!.image[5]!.y - 18 };
        views[7]!.image[11] = { x: views[7]!.image[11]!.x - 30, y: views[7]!.image[11]!.y };
        const res = calibrateIntrinsics(views, W, H)!;
        expect(Math.abs(res.f - CAM.f) / CAM.f).toBeLessThan(0.01);
        expect(res.rmsPx).toBeLessThan(0.5);
    });

    it("rejects too few views", () => {
        expect(calibrateIntrinsics(synthViews(0.3).slice(0, 2), W, H)).toBeNull();
    });

    it("vfov <-> focal round-trips", () => {
        expect(focalFromVfov(vfovFromFocal(1234, 1080), 1080)).toBeCloseTo(1234, 9);
        expect(vfovFromFocal(540, 1080)).toBeCloseTo(90, 9);
    });
});

describe("ChArUco board", () => {
    it("5x7 board: 17 markers, 24 inner corners, unique squares", () => {
        const spec = boardSpec();
        expect(markerCount(spec)).toBe(17);
        expect(innerCornerCount(spec)).toBe(24);
        const squares = new Set(Array.from({ length: 17 }, (_, i) => JSON.stringify(markerSquare(spec, i))));
        expect(squares.size).toBe(17);
        expect(markerSquare(spec, 17)).toBeNull();
    });

    it("marker codes are 16 bits and DICT_4X4_50 id 0 matches OpenCV", () => {
        expect(markerBits(0)).toBe("1011010100110010");
        for (let i = 0; i < 50; i++) expect(markerBits(i)).toHaveLength(16);
        expect(() => markerBits(50)).toThrow();
    });

    it("boardLuma draws black squares, marker borders and bits", () => {
        const spec = boardSpec();
        expect(boardLuma(spec, 0.5, 0.5)).toBe(0); // (0,0) black square
        expect(boardLuma(spec, 1.05, 0.05)).toBe(255); // white margin of marker square (1,0)
        expect(boardLuma(spec, 1.2, 1.0 - 0.2)).toBe(0); // marker border
        expect(boardLuma(spec, -0.1, 2)).toBe(255);
    });
});

/** Render the board through a homography into a grey image (4×4 supersampling). */
function renderBoard(spec: ReturnType<typeof boardSpec>, h: ArrayLike<number>, w: number, ht: number): Float32Array {
    const inv = homographyDLT(
        [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
            { x: 0.5, y: 0.3 },
        ].map((p) => applyHomography(h, p)),
        [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
            { x: 0.5, y: 0.3 },
        ],
    )!;
    const out = new Float32Array(w * ht);
    for (let y = 0; y < ht; y++)
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let sy = 0; sy < 4; sy++)
                for (let sx = 0; sx < 4; sx++) {
                    const b = applyHomography(inv, { x: x - 0.375 + sx * 0.25, y: y - 0.375 + sy * 0.25 });
                    s += boardLuma(spec, b.x, b.y);
                }
            out[y * w + x] = 30 + (s / 16) * 0.8;
        }
    return out;
}

describe("ChArUco corners", () => {
    const spec = boardSpec();
    // Board (square units) -> image: 60 px squares, mild perspective.
    const Hs = [60, 8, 120, -6, 58, 90, 0.004, 0.002, 1];
    const w = 640;
    const h = 640;
    const grey = renderBoard(spec, Hs, w, h);

    function markersFromTruth(noise: number, rand = mulberry32(5)): DetectedMarker[] {
        return Array.from({ length: markerCount(spec) }, (_, id) => ({
            id,
            corners: markerBoardCorners(spec, id)!.map((p) => {
                const q = applyHomography(Hs, p);
                return { x: q.x + noise * gaussian(rand), y: q.y + noise * gaussian(rand) };
            }),
        }));
    }

    it("cornerSubPix converges to a rendered X-corner from 2 px away", () => {
        const truth = applyHomography(Hs, innerCorner(spec, 7));
        const q = cornerSubPix(grey, w, h, { x: truth.x + 1.6, y: truth.y - 1.2 }, 5)!;
        expect(Math.hypot(q.x - truth.x, q.y - truth.y)).toBeLessThan(0.15);
    });

    it("finds every inner corner with sub-pixel accuracy from noisy marker corners", () => {
        const det = charucoCorners(spec, markersFromTruth(0.8), grey, w, h);
        expect(det.ids.length).toBe(innerCornerCount(spec));
        det.ids.forEach((id, i) => {
            const t = applyHomography(Hs, innerCorner(spec, id));
            expect(Math.hypot(det.image[i]!.x - t.x, det.image[i]!.y - t.y)).toBeLessThan(0.2);
        });
    });

    it("drops a mis-decoded marker and duplicate ids", () => {
        const ms = markersFromTruth(0.3);
        ms[4] = { id: 4, corners: ms[11]!.corners }; // wrong place for id 4
        ms.push({ id: 9, corners: ms[9]!.corners.map((p) => ({ x: p.x + 1, y: p.y })) }); // duplicate 9
        const det = charucoCorners(spec, ms, grey, w, h);
        expect(det.markers).toBe(markerCount(spec) - 2);
        expect(det.ids.length).toBeGreaterThan(18);
    });

    it("js-aruco2 decodes every marker of the rendered board and the corners land within 0.25 px", async () => {
        const detect = createMarkerDetector(await loadAruco());
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const v = grey[i]!;
            rgba[4 * i] = v;
            rgba[4 * i + 1] = v;
            rgba[4 * i + 2] = v;
            rgba[4 * i + 3] = 255;
        }
        const markers = detect(rgba, w, h);
        expect(new Set(markers.map((m) => m.id)).size).toBe(markerCount(spec));
        // Corner order must match markerBoardCorners (TL, TR, BR, BL of the marker).
        for (const m of markers) {
            const truth = markerBoardCorners(spec, m.id)!.map((p) => applyHomography(Hs, p));
            m.corners.forEach((c, i) => expect(Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y)).toBeLessThan(3));
        }
        const det = detectBoard(spec, detect, { rgba, w, h });
        expect(det.ids.length).toBe(innerCornerCount(spec));
        det.ids.forEach((id, i) => {
            const t = applyHomography(Hs, innerCorner(spec, id));
            expect(Math.hypot(det.image[i]!.x - t.x, det.image[i]!.y - t.y)).toBeLessThan(0.25);
        });
    });
});
