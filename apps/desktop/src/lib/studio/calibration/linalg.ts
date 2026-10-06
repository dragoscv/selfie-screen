/**
 * Small dense linear algebra for the calibration passes (lens + scene).
 * Row-major Float64Array matrices; sizes stay below ~100, so plain loops win.
 */

export interface Pt {
    x: number;
    y: number;
}

/**
 * Symmetric eigen-decomposition (cyclic Jacobi). Returns eigenvalues in
 * ascending order; eigenvector k is column k of `vectors` (vectors[i * n + k]).
 */
export function symEigen(input: ArrayLike<number>, n: number): { values: Float64Array; vectors: Float64Array } {
    const a = Float64Array.from(input);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    let norm = 0;
    for (let i = 0; i < n * n; i++) norm += a[i]! * a[i]!;
    const tol = 1e-26 * (norm || 1);
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! * a[p * n + q]!;
        if (off <= tol) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q]!;
                if (apq === 0) continue;
                const theta = (a[q * n + q]! - a[p * n + p]!) / (2 * apq);
                const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p]!;
                    const akq = a[k * n + q]!;
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k]!;
                    const aqk = a[q * n + k]!;
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p]!;
                    const vkq = v[k * n + q]!;
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i]! - a[j * n + j]!);
    const values = new Float64Array(n);
    const vectors = new Float64Array(n * n);
    order.forEach((src, dst) => {
        values[dst] = a[src * n + src]!;
        for (let i = 0; i < n; i++) vectors[i * n + dst] = v[i * n + src]!;
    });
    return { values, vectors };
}

/** Eigenvector of the smallest eigenvalue (the least-squares null vector of AᵀA). */
export function smallestEigenvector(ata: ArrayLike<number>, n: number): Float64Array {
    const { vectors } = symEigen(ata, n);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = vectors[i * n]!;
    return out;
}

/** Solve A x = b (n×n, Gaussian elimination with partial pivoting). Null when singular. */
export function solveLinear(aIn: ArrayLike<number>, bIn: ArrayLike<number>, n: number): Float64Array | null {
    const a = Float64Array.from(aIn);
    const b = Float64Array.from(bIn);
    for (let col = 0; col < n; col++) {
        let piv = col;
        let best = Math.abs(a[col * n + col]!);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(a[r * n + col]!);
            if (v > best) {
                best = v;
                piv = r;
            }
        }
        if (best < 1e-300) return null;
        if (piv !== col) {
            for (let k = 0; k < n; k++) {
                const t = a[col * n + k]!;
                a[col * n + k] = a[piv * n + k]!;
                a[piv * n + k] = t;
            }
            const t = b[col]!;
            b[col] = b[piv]!;
            b[piv] = t;
        }
        const d = a[col * n + col]!;
        for (let r = col + 1; r < n; r++) {
            const f = a[r * n + col]! / d;
            if (f === 0) continue;
            for (let k = col; k < n; k++) a[r * n + k] = a[r * n + k]! - f * a[col * n + k]!;
            b[r] = b[r]! - f * b[col]!;
        }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let s = b[r]!;
        for (let k = r + 1; k < n; k++) s -= a[r * n + k]! * x[k]!;
        x[r] = s / a[r * n + r]!;
    }
    for (const v of x) if (!Number.isFinite(v)) return null;
    return x;
}

/** 3×3 helpers (row-major). */
export function mat3Mul(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
    const o = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    return o;
}

export function mat3Inv(m: ArrayLike<number>): Float64Array | null {
    const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!];
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-300) return null;
    const k = 1 / det;
    return Float64Array.from([A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]);
}

/** Rotation vector (axis × angle) -> 3×3 rotation matrix. */
export function rodrigues(rx: number, ry: number, rz: number): Float64Array {
    const th = Math.hypot(rx, ry, rz);
    if (th < 1e-12) return Float64Array.from([1, -rz, ry, rz, 1, -rx, -ry, rx, 1]);
    const kx = rx / th;
    const ky = ry / th;
    const kz = rz / th;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const C = 1 - c;
    return Float64Array.from([
        c + kx * kx * C,
        kx * ky * C - kz * s,
        kx * kz * C + ky * s,
        ky * kx * C + kz * s,
        c + ky * ky * C,
        ky * kz * C - kx * s,
        kz * kx * C - ky * s,
        kz * ky * C + kx * s,
        c + kz * kz * C,
    ]);
}

/** 3×3 rotation matrix -> rotation vector. */
export function rotationToRodrigues(r: ArrayLike<number>): [number, number, number] {
    const cos = Math.min(1, Math.max(-1, (r[0]! + r[4]! + r[8]! - 1) / 2));
    const th = Math.acos(cos);
    const vx = r[7]! - r[5]!;
    const vy = r[2]! - r[6]!;
    const vz = r[3]! - r[1]!;
    if (th < 1e-9) return [vx / 2, vy / 2, vz / 2];
    const s = Math.sin(th);
    if (s > 1e-6) {
        const k = th / (2 * s);
        return [vx * k, vy * k, vz * k];
    }
    // Near π: axis from the diagonal, signs from the off-diagonal terms.
    const x = Math.sqrt(Math.max(0, (r[0]! + 1) / 2));
    let y = Math.sqrt(Math.max(0, (r[4]! + 1) / 2));
    let z = Math.sqrt(Math.max(0, (r[8]! + 1) / 2));
    if (r[1]! < 0) y = -y;
    if (r[2]! < 0) z = -z;
    return [x * th, y * th, z * th];
}

/** Nearest rotation to M (polar decomposition R = M (MᵀM)^-1/2). */
export function nearestRotation(m: ArrayLike<number>): Float64Array {
    const mt = Float64Array.from([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
    const mtm = mat3Mul(mt, m);
    const { values, vectors } = symEigen(mtm, 3);
    const inv = new Float64Array(9);
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += (vectors[i * 3 + k]! * vectors[j * 3 + k]!) / Math.sqrt(Math.max(values[k]!, 1e-30));
            inv[i * 3 + j] = s;
        }
    return mat3Mul(m, inv);
}

/** Deterministic PRNG (mulberry32) for RANSAC and tests. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal sample from a uniform source (Box–Muller). */
export function gaussian(rand: () => number): number {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
