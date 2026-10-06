import { mat3Inv, nearestRotation, rodrigues, rotationToRodrigues, smallestEigenvector, solveLinear, type Pt } from "./linalg.js";

/**
 * Planar-target camera calibration (Zhang 2000), pure and synchronous.
 *
 * Model: square pixels, no skew, principal point (cx, cy), radial k1, k2:
 *   x = R X + t,  (xn, yn) = (x/z, y/z),  d = 1 + k1 r² + k2 r⁴,
 *   u = f d xn + cx,  v = f d yn + cy.
 * Initial f: Zhang's orthogonality constraints with the principal point at
 * the image centre (one unknown 1/f², linear least squares). Extrinsics per
 * view from the homography, then Levenberg–Marquardt over all parameters,
 * one outlier-rejection pass at 3·RMS.
 */

export type Mat3 = Float64Array;

/** Homography (board -> image) with Hartley normalisation; null when degenerate. */
export function homographyDLT(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
    const n = Math.min(src.length, dst.length);
    if (n < 4) return null;
    const norm = (pts: readonly Pt[]) => {
        let mx = 0;
        let my = 0;
        for (let i = 0; i < n; i++) {
            mx += pts[i]!.x;
            my += pts[i]!.y;
        }
        mx /= n;
        my /= n;
        let d = 0;
        for (let i = 0; i < n; i++) d += Math.hypot(pts[i]!.x - mx, pts[i]!.y - my);
        d /= n;
        const s = d > 1e-12 ? Math.SQRT2 / d : 1;
        return { s, mx, my };
    };
    const a = norm(src);
    const b = norm(dst);
    const ata = new Float64Array(81);
    const row = new Float64Array(9);
    const add = () => {
        for (let i = 0; i < 9; i++) {
            const ri = row[i]!;
            if (ri === 0) continue;
            for (let j = 0; j < 9; j++) ata[i * 9 + j] = ata[i * 9 + j]! + ri * row[j]!;
        }
    };
    for (let i = 0; i < n; i++) {
        const x = (src[i]!.x - a.mx) * a.s;
        const y = (src[i]!.y - a.my) * a.s;
        const u = (dst[i]!.x - b.mx) * b.s;
        const v = (dst[i]!.y - b.my) * b.s;
        row.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
        add();
        row.set([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
        add();
    }
    const hn = smallestEigenvector(ata, 9);
    // H = Tb⁻¹ · Hn · Ta
    const ta = Float64Array.from([a.s, 0, -a.s * a.mx, 0, a.s, -a.s * a.my, 0, 0, 1]);
    const tbi = Float64Array.from([1 / b.s, 0, b.mx, 0, 1 / b.s, b.my, 0, 0, 1]);
    const h = mul3(tbi, mul3(hn, ta));
    const k = h[8]!;
    if (!Number.isFinite(k) || Math.abs(k) < 1e-15) return null;
    for (let i = 0; i < 9; i++) h[i] = h[i]! / k;
    return h;
}

function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
    const o = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    return o;
}

export function applyHomography(h: ArrayLike<number>, p: Pt): Pt {
    const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
    return { x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w, y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w };
}

/**
 * Zhang closed form for f with a known principal point (square pixels, no
 * skew): ω = diag(a, a, 1) with a = 1/f², constraints h1ᵀωh2 = 0 and
 * h1ᵀωh1 = h2ᵀωh2 per homography. Null when the views carry no tilt.
 */
export function focalFromHomographies(hs: readonly ArrayLike<number>[], cx: number, cy: number): number | null {
    let num = 0;
    let den = 0;
    for (const h0 of hs) {
        // Move the principal point to the origin: H' = T H, T = [1 0 -cx; 0 1 -cy; 0 0 1].
        const h = mul3([1, 0, -cx, 0, 1, -cy, 0, 0, 1], h0);
        const [h11, h12, h13] = [h[0]!, h[3]!, h[6]!]; // column 1
        const [h21, h22, h23] = [h[1]!, h[4]!, h[7]!]; // column 2
        const scale = 1 / Math.max(1e-12, Math.hypot(h11, h12, h21, h22));
        const p1 = (h11 * h21 + h12 * h22) * scale * scale;
        const q1 = h13 * h23 * scale * scale;
        const p2 = (h11 * h11 + h12 * h12 - h21 * h21 - h22 * h22) * scale * scale;
        const q2 = (h13 * h13 - h23 * h23) * scale * scale;
        num += p1 * q1 + p2 * q2;
        den += p1 * p1 + p2 * p2;
    }
    if (den < 1e-18) return null;
    const a = -num / den;
    if (!(a > 0)) return null;
    return 1 / Math.sqrt(a);
}

/** Extrinsics of one view from its homography and the intrinsics (R as a rotation vector, t in board units). */
export function poseFromHomography(h: ArrayLike<number>, f: number, cx: number, cy: number): { r: [number, number, number]; t: [number, number, number] } | null {
    const ki = mat3Inv([f, 0, cx, 0, f, cy, 0, 0, 1]);
    if (!ki) return null;
    const m = mul3(ki, h);
    const c1 = [m[0]!, m[3]!, m[6]!];
    const c2 = [m[1]!, m[4]!, m[7]!];
    const c3 = [m[2]!, m[5]!, m[8]!];
    let lam = 2 / (Math.hypot(c1[0]!, c1[1]!, c1[2]!) + Math.hypot(c2[0]!, c2[1]!, c2[2]!));
    if (c3[2]! * lam < 0) lam = -lam; // board in front of the camera
    const r1 = c1.map((v) => v * lam);
    const r2 = c2.map((v) => v * lam);
    const r3 = [r1[1]! * r2[2]! - r1[2]! * r2[1]!, r1[2]! * r2[0]! - r1[0]! * r2[2]!, r1[0]! * r2[1]! - r1[1]! * r2[0]!];
    const rot = nearestRotation([r1[0]!, r2[0]!, r3[0]!, r1[1]!, r2[1]!, r3[1]!, r1[2]!, r2[2]!, r3[2]!]);
    return { r: rotationToRodrigues(rot), t: [c3[0]! * lam, c3[1]! * lam, c3[2]! * lam] };
}

export interface Intrinsics {
    f: number;
    cx: number;
    cy: number;
    k1: number;
    k2: number;
}

/** Project a board point (z = 0) with intrinsics + pose. */
export function projectPoint(k: Intrinsics, r: readonly number[], t: readonly number[], p: Pt): Pt {
    const R = rodrigues(r[0]!, r[1]!, r[2]!);
    return projectWith(k, R, t, p);
}

function projectWith(k: Intrinsics, R: ArrayLike<number>, t: readonly number[], p: Pt): Pt {
    const x = R[0]! * p.x + R[1]! * p.y + t[0]!;
    const y = R[3]! * p.x + R[4]! * p.y + t[1]!;
    const z = R[6]! * p.x + R[7]! * p.y + t[2]!;
    const xn = x / z;
    const yn = y / z;
    const r2 = xn * xn + yn * yn;
    const d = 1 + k.k1 * r2 + k.k2 * r2 * r2;
    return { x: k.f * d * xn + k.cx, y: k.f * d * yn + k.cy };
}

export interface ViewObservations {
    /** Board points (any planar unit, z = 0). */
    board: Pt[];
    /** Matching image points in pixels. */
    image: Pt[];
}

export interface CalibrationResult extends Intrinsics {
    vfovDeg: number;
    rmsPx: number;
    views: number;
}

export function vfovFromFocal(fPx: number, heightPx: number): number {
    return (2 * Math.atan(heightPx / 2 / fPx) * 180) / Math.PI;
}

export function focalFromVfov(vfovDeg: number, heightPx: number): number {
    return heightPx / 2 / Math.tan((vfovDeg * Math.PI) / 360);
}

const N_INTR = 5;

function residuals(params: Float64Array, views: readonly ViewObservations[], out: Float64Array): void {
    const k: Intrinsics = { f: params[0]!, cx: params[1]!, cy: params[2]!, k1: params[3]!, k2: params[4]! };
    let o = 0;
    views.forEach((v, i) => {
        const b = N_INTR + 6 * i;
        const R = rodrigues(params[b]!, params[b + 1]!, params[b + 2]!);
        const t = [params[b + 3]!, params[b + 4]!, params[b + 5]!];
        for (let j = 0; j < v.board.length; j++) {
            const q = projectWith(k, R, t, v.board[j]!);
            out[o++] = q.x - v.image[j]!.x;
            out[o++] = q.y - v.image[j]!.y;
        }
    });
}

/** Levenberg–Marquardt over intrinsics + all poses (block-sparse Jacobian, numeric). */
function refine(params: Float64Array, views: readonly ViewObservations[], iterations = 60): number {
    const m = views.reduce((s, v) => s + 2 * v.board.length, 0);
    const n = params.length;
    const r = new Float64Array(m);
    const rTry = new Float64Array(m);
    const rStep = new Float64Array(m);
    const cost = (p: Float64Array, buf: Float64Array) => {
        residuals(p, views, buf);
        let s = 0;
        for (const v of buf) s += v * v;
        return s;
    };
    let c = cost(params, r);
    let lambda = 1e-3;
    // Row range of each view, for the block structure.
    const starts: number[] = [];
    let acc = 0;
    for (const v of views) {
        starts.push(acc);
        acc += 2 * v.board.length;
    }
    for (let it = 0; it < iterations; it++) {
        // Numeric Jacobian columns; pose columns only touch their view's rows.
        const J = new Float64Array(m * n);
        for (let j = 0; j < n; j++) {
            const hstep = 1e-6 * Math.max(1, Math.abs(params[j]!));
            const p = params[j]!;
            params[j] = p + hstep;
            residuals(params, views, rStep);
            params[j] = p;
            let lo = 0;
            let hi = m;
            if (j >= N_INTR) {
                const vi = Math.floor((j - N_INTR) / 6);
                lo = starts[vi]!;
                hi = lo + 2 * views[vi]!.board.length;
            }
            for (let i = lo; i < hi; i++) J[i * n + j] = (rStep[i]! - r[i]!) / hstep;
        }
        const JtJ = new Float64Array(n * n);
        const Jtr = new Float64Array(n);
        for (let i = 0; i < m; i++) {
            const ri = r[i]!;
            const rowOff = i * n;
            for (let a = 0; a < n; a++) {
                const ja = J[rowOff + a]!;
                if (ja === 0) continue;
                Jtr[a] = Jtr[a]! + ja * ri;
                for (let b = a; b < n; b++) {
                    const jb = J[rowOff + b]!;
                    if (jb !== 0) JtJ[a * n + b] = JtJ[a * n + b]! + ja * jb;
                }
            }
        }
        for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a * n + b] = JtJ[b * n + a]!;
        let improved = false;
        for (let tries = 0; tries < 10; tries++) {
            const A = Float64Array.from(JtJ);
            for (let a = 0; a < n; a++) A[a * n + a] = A[a * n + a]! * (1 + lambda) + 1e-12;
            const neg = Jtr.map((v) => -v);
            const delta = solveLinear(A, neg, n);
            if (!delta) {
                lambda *= 10;
                continue;
            }
            const trial = params.map((v, i) => v + delta[i]!);
            const ct = cost(trial, rTry);
            if (ct < c) {
                const rel = (c - ct) / Math.max(c, 1e-30);
                params.set(trial);
                r.set(rTry);
                c = ct;
                lambda = Math.max(lambda / 10, 1e-9);
                improved = true;
                if (rel < 1e-10) return c;
                break;
            }
            lambda *= 10;
        }
        if (!improved) break;
    }
    return c;
}

/**
 * Calibrate from ≥ 3 planar views (≥ 6 points each). Image size is the raw
 * video size; vFOV is for that height. Null when the views are degenerate.
 */
export function calibrateIntrinsics(viewsIn: readonly ViewObservations[], width: number, height: number): CalibrationResult | null {
    let views = viewsIn.filter((v) => v.board.length >= 6 && v.board.length === v.image.length);
    if (views.length < 3) return null;
    const hs: Mat3[] = [];
    const keep: ViewObservations[] = [];
    for (const v of views) {
        const h = homographyDLT(v.board, v.image);
        if (h) {
            hs.push(h);
            keep.push(v);
        }
    }
    views = keep;
    const cx0 = (width - 1) / 2;
    const cy0 = (height - 1) / 2;
    const f0 = focalFromHomographies(hs, cx0, cy0);
    if (!f0 || !Number.isFinite(f0)) return null;
    const build = (vs: readonly ViewObservations[], hsUse: readonly Mat3[], k: Intrinsics): Float64Array | null => {
        const p = new Float64Array(N_INTR + 6 * vs.length);
        p.set([k.f, k.cx, k.cy, k.k1, k.k2]);
        for (let i = 0; i < vs.length; i++) {
            const pose = poseFromHomography(hsUse[i]!, k.f, k.cx, k.cy);
            if (!pose) return null;
            p.set([...pose.r, ...pose.t], N_INTR + 6 * i);
        }
        return p;
    };
    let params = build(views, hs, { f: f0, cx: cx0, cy: cy0, k1: 0, k2: 0 });
    if (!params) return null;
    let cost = refine(params, views);
    let count = views.reduce((s, v) => s + v.board.length, 0);
    // One outlier pass: drop points beyond 3·RMS (min 1 px) and re-solve from the current estimate.
    const rmsAll = Math.sqrt(cost / count);
    const res = new Float64Array(2 * count);
    residuals(params, views, res);
    let o = 0;
    let dropped = 0;
    const cleaned = views.map((v) => {
        const board: Pt[] = [];
        const image: Pt[] = [];
        for (let j = 0; j < v.board.length; j++) {
            const e = Math.hypot(res[o]!, res[o + 1]!);
            o += 2;
            if (e <= Math.max(1, 3 * rmsAll)) {
                board.push(v.board[j]!);
                image.push(v.image[j]!);
            } else dropped++;
        }
        return { board, image };
    });
    if (dropped > 0) {
        const k: Intrinsics = { f: params[0]!, cx: params[1]!, cy: params[2]!, k1: params[3]!, k2: params[4]! };
        const vs: ViewObservations[] = [];
        const poses: number[][] = [];
        cleaned.forEach((v, i) => {
            if (v.board.length < 6) return;
            vs.push(v);
            poses.push(Array.from(params!.subarray(N_INTR + 6 * i, N_INTR + 6 * i + 6)));
        });
        if (vs.length >= 3) {
            const p = new Float64Array(N_INTR + 6 * vs.length);
            p.set([k.f, k.cx, k.cy, k.k1, k.k2]);
            poses.forEach((pp, i) => p.set(pp, N_INTR + 6 * i));
            params = p;
            views = vs;
            cost = refine(params, views);
            count = views.reduce((s, v) => s + v.board.length, 0);
        }
    }
    const f = params[0]!;
    const out: CalibrationResult = {
        f,
        cx: params[1]!,
        cy: params[2]!,
        k1: params[3]!,
        k2: params[4]!,
        vfovDeg: vfovFromFocal(f, height),
        rmsPx: Math.sqrt(cost / count),
        views: views.length,
    };
    if (![out.f, out.cx, out.cy, out.k1, out.k2, out.rmsPx].every(Number.isFinite) || out.f <= 0) return null;
    return out;
}
