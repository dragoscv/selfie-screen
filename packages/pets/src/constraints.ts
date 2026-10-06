import type { BodySnapshot, Vec3 } from "./space.js";

/**
 * Hard spatial constraints for pets (owner: "pets overlap / intersect").
 * Steering only has to LOOK good; this pass guarantees, every frame, that:
 *  - no pet is inside the owner's body (head sphere, neck/torso/arm capsules,
 *    inflated by the pet's radius), and
 *  - pets keep a minimum distance from each other.
 * Position-based projection (2 iterations), deterministic, allocation-light.
 */

export interface Capsule {
    a: Vec3;
    b: Vec3;
    r: number;
    /** Body part, for the debug overlay. */
    part: "head" | "neck" | "torso" | "upperArmL" | "upperArmR" | "foreArmL" | "foreArmR";
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Closest point to `p` on segment ab. */
export function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 < 1e-12) return a;
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
    return add(a, mul(ab, t));
}

/** Owner body as capsules (metres). Only joints with confidence > 0.3 contribute. */
export function bodyCapsules(body: BodySnapshot | null): Capsule[] {
    if (!body?.present) return [];
    const j = body.joints;
    const out: Capsule[] = [];
    const ok = (n: keyof typeof j) => j[n].conf > 0.3;
    if (body.head.conf > 0.3) out.push({ a: body.head.p, b: body.head.p, r: 0.11, part: "head" });
    if (ok("leftShoulder") && ok("rightShoulder")) {
        const mid: Vec3 = mul(add(j.leftShoulder.p, j.rightShoulder.p), 0.5);
        if (body.head.conf > 0.3) out.push({ a: mid, b: add(body.head.p, [0, -0.08, 0]), r: 0.06, part: "neck" });
        // Torso: shoulder line down to the hips (or 0.5 m down when hips are not seen).
        const hipsOk = ok("leftHip") && ok("rightHip");
        const hip: Vec3 = hipsOk ? mul(add(j.leftHip.p, j.rightHip.p), 0.5) : add(mid, [0, -0.5, 0]);
        // Wide torso: two capsules from each shoulder down.
        out.push({ a: j.leftShoulder.p, b: add(hip, [j.leftShoulder.p[0] - mid[0], 0, 0]), r: 0.1, part: "torso" });
        out.push({ a: j.rightShoulder.p, b: add(hip, [j.rightShoulder.p[0] - mid[0], 0, 0]), r: 0.1, part: "torso" });
    }
    const arm = (s: keyof typeof j, e: keyof typeof j, w: keyof typeof j, u: Capsule["part"], f: Capsule["part"]) => {
        if (ok(s) && ok(e)) out.push({ a: j[s].p, b: j[e].p, r: 0.05, part: u });
        if (ok(e) && ok(w)) out.push({ a: j[e].p, b: j[w].p, r: 0.045, part: f });
    };
    arm("leftShoulder", "leftElbow", "leftWrist", "upperArmL", "foreArmL");
    arm("rightShoulder", "rightElbow", "rightWrist", "upperArmR", "foreArmR");
    return out;
}

/** A pet as a sphere around its body centre (contact point + half height). */
export interface PetBody {
    /** Contact point (feet), metres; mutated in place by `resolve`. */
    p: Vec3;
    /** Radius (m), ~0.45 x pet height. */
    r: number;
    /** Centre height above the contact point (m). */
    cy: number;
    /** Perched on a body part: that part is a SURFACE for it, not an obstacle (it sits on top). */
    perchedOn: "shoulder" | "head" | "hand" | null;
}

/** Minimum gap between two pets (m), on top of their radii. */
export const PET_GAP_M = 0.03;

export interface ResolveReport {
    /** Total correction applied (m) per pet, for the debug overlay. */
    pushed: number[];
}

/**
 * Push pets out of the body capsules and apart from each other. Perched pets
 * are only pushed out of parts other than the one they sit on, and only
 * UPWARD/outward from it (they sit on it, not in it).
 */
export function resolve(pets: PetBody[], capsules: readonly Capsule[], iterations = 2): ResolveReport {
    const pushed = pets.map(() => 0);
    for (let it = 0; it < iterations; it++) {
        for (const [i, pet] of pets.entries()) {
            for (const c of capsules) {
                if (pet.perchedOn === "head" && c.part === "head") continue;
                if (pet.perchedOn === "shoulder" && (c.part === "torso" || c.part === "upperArmL" || c.part === "upperArmR")) continue;
                if (pet.perchedOn === "hand" && (c.part === "foreArmL" || c.part === "foreArmR")) continue;
                const centre: Vec3 = add(pet.p, [0, pet.cy, 0]);
                const q = closestOnSegment(centre, c.a, c.b);
                const d = sub(centre, q);
                const dist = len(d);
                const min = c.r + pet.r;
                if (dist >= min) continue;
                // Push direction: away from the axis; degenerate -> towards the camera (+Z) and up.
                const n: Vec3 = dist > 1e-6 ? mul(d, 1 / dist) : [0, 0.6, 0.8];
                const corr = min - dist;
                pet.p = add(pet.p, mul(n, corr));
                pushed[i] = (pushed[i] ?? 0) + corr;
            }
        }
        for (let i = 0; i < pets.length; i++) {
            for (let k = i + 1; k < pets.length; k++) {
                const a = pets[i] as PetBody;
                const b = pets[k] as PetBody;
                const ca = add(a.p, [0, a.cy, 0]);
                const cb = add(b.p, [0, b.cy, 0]);
                const d = sub(cb, ca);
                const dist = len(d);
                const min = a.r + b.r + PET_GAP_M;
                if (dist >= min) continue;
                // Deterministic split direction when exactly coincident: along X.
                const n: Vec3 = dist > 1e-6 ? mul(d, 1 / dist) : [1, 0, 0];
                const half = (min - dist) / 2;
                a.p = sub(a.p, mul(n, half));
                b.p = add(b.p, mul(n, half));
                pushed[i] = (pushed[i] ?? 0) + half;
                pushed[k] = (pushed[k] ?? 0) + half;
            }
        }
    }
    return { pushed };
}

/**
 * Perch reservations: one pet per perch anchor. A pet asking for an anchor
 * held by another gets `false` and picks its next choice. Reservations expire
 * when the holder releases them (anchor change) or after `ttlMs` without renewal.
 */
export class Reservations {
    readonly #held = new Map<string, { owner: string; until: number }>();

    constructor(readonly ttlMs = 1500) {}

    /** Try to take or renew `anchor` for `owner`. */
    take(anchor: string, owner: string, nowMs: number): boolean {
        const h = this.#held.get(anchor);
        if (h && h.owner !== owner && h.until > nowMs) return false;
        this.#held.set(anchor, { owner, until: nowMs + this.ttlMs });
        return true;
    }

    holder(anchor: string, nowMs: number): string | null {
        const h = this.#held.get(anchor);
        return h && h.until > nowMs ? h.owner : null;
    }

    release(owner: string): void {
        for (const [k, v] of this.#held) if (v.owner === owner) this.#held.delete(k);
    }
}

/** Anchors that are exclusive (a perch holds one pet); paths like the orbit can be shared. */
export const EXCLUSIVE_ANCHORS: ReadonlySet<string> = new Set(["shoulderL", "shoulderR", "crown", "handL", "handR", "ledgeL", "ledgeR", "centre", "point"]);
