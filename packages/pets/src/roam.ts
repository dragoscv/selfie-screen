import type { PetFamily } from "./catalogue.js";
import type { BodySnapshot, Pinhole, Vec3 } from "./space.js";
import { project, unproject } from "./space.js";

/**
 * Where a pet is in the world, frame by frame: an anchor graph over the
 * owner's body plus a steering model per locomotion style. Pure (no three.js),
 * clock-injected, deterministic for a given random source.
 *
 * Anchors (all in world metres, recomputed each frame from the BodySnapshot):
 *   shoulderL/R  - perch on top of each shoulder, a hair in front of the body
 *   crown        - on top of the head
 *   handL/R      - just above a raised wrist (only offered while the hand is seen)
 *   ledgeL/R     - the bottom edge of the frame, beside the body (always valid)
 *   orbit        - a circular path around the head, in depth (fliers only):
 *                  passes BEHIND the owner (occluded by the person mask) and in front
 *   centre       - in front of the face (big gifts)
 *   point        - where the owner points (point_left/right), at body depth
 * When the body is not seen, every body anchor is invalid and the pet goes to a
 * ledge: it never leaves the frame and never pops.
 */

export const ANCHORS = ["shoulderL", "shoulderR", "crown", "handL", "handR", "ledgeL", "ledgeR", "orbit", "centre", "point"] as const;
export type AnchorId = (typeof ANCHORS)[number];

export type Locomotion = "fly" | "walk" | "hover";

export function locomotionOf(family: PetFamily): Locomotion {
    if (family === "bird" || family === "dragon") return "fly";
    if (family === "robot") return "hover";
    return "walk";
}

/** What the renderer needs per frame. */
export interface PetPose {
    /** Contact point (feet) in world metres. */
    p: Vec3;
    /** Body yaw around +Y (radians, 0 = facing the camera), smoothed. */
    yaw: number;
    /** Lean (radians) into the direction of travel. */
    pitch: number;
    roll: number;
    /** Locomotion clip the animation layer should blend in (null = keep the behaviour clip). */
    gait: "fly" | "walk" | "hop" | null;
    /** 0..1 how strongly the gait clip should override the behaviour clip. */
    gaitWeight: number;
    /** Current anchor and whether the pet has arrived. */
    anchor: AnchorId;
    settled: boolean;
    /** World point the head should look at. */
    lookAt: Vec3;
    /** 0..1 fade (only < 1 while the stage itself is hiding/showing the pet). */
    alpha: number;
    /** Planned path for the debug overlay (world points). */
    path: readonly Vec3[];
}

export interface RoamOptions {
    side: "left" | "right";
    family: PetFamily;
    /** Pet height in metres (keeps perches above the surface). */
    heightM: number;
    rand?: () => number;
}

/** Steering limits per locomotion: max speed (m/s), accel (m/s²). */
const LIMITS: Readonly<Record<Locomotion, { speed: number; accel: number }>> = {
    fly: { speed: 1.4, accel: 5 },
    hover: { speed: 0.9, accel: 3 },
    walk: { speed: 0.6, accel: 4 },
};
/** Arrive radius (m). */
const ARRIVE_M = 0.015;
/** Mean dwell at a perch before considering another, ms. */
const DWELL_MS = 14_000;
/** An anchor that disappears is kept (at its last position) this long before the pet leaves it. */
const ANCHOR_GRACE_MS = 900;

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Shortest signed angle difference. */
export function angleDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Anchor positions for this frame; null = not available now. */
export function anchorPoints(body: BodySnapshot | null, pin: Pinhole, side: "left" | "right", tSec: number, pointAt: Vec3 | null): Record<AnchorId, Vec3 | null> {
    // Ledges: the bottom of the frame, near each side, 0.25 m IN FRONT of the owner (the
    // desk edge for a seated streamer), never at or behind the body plane. The contact
    // point is the pet's FEET, so v = 0.96 keeps the whole pet visible above it.
    const d = body?.distanceM ?? 1;
    const ledgeD = Math.max(0.4, d - 0.25);
    const ledgeL = unproject(pin, 0.2, 0.96, ledgeD);
    const ledgeR = unproject(pin, 0.8, 0.96, ledgeD);
    const out: Record<AnchorId, Vec3 | null> = {
        shoulderL: null,
        shoulderR: null,
        crown: null,
        handL: null,
        handR: null,
        ledgeL,
        ledgeR,
        orbit: null,
        centre: null,
        point: pointAt,
    };
    if (!body?.present) return out;
    const j = body.joints;
    const span = body.shoulders.span;
    const r = body.shoulders.right;
    // Shoulder top: the joint is inside the deltoid; perch 0.06 m up, 12 % of the span outward, 4 cm in front.
    const perch = (s: Vec3, sign: number): Vec3 => [s[0] + r[0] * span * 0.1 * sign, s[1] + 0.06, s[2] + 0.04];
    // Image-left = smaller x. Pick by geometry, not by MediaPipe's anatomical side (mirroring).
    const shoulders = [j.leftShoulder, j.rightShoulder].filter((s) => s.conf > 0.3).sort((a, b) => a.p[0] - b.p[0]);
    if (shoulders.length === 2) {
        const [a, b] = shoulders as [typeof j.leftShoulder, typeof j.leftShoulder];
        out.shoulderL = perch(a.p, -1);
        out.shoulderR = perch(b.p, 1);
    }
    if (body.head.conf > 0.3) {
        out.crown = add(body.crown, [0, 0.01, 0.02]);
        out.centre = add(body.head.p, [0, -0.05, 0.35]);
        // Orbit: an ellipse around the head (0.34 m wide, 0.28 m deep) centred 0.1 m IN FRONT,
        // so ~70 % of the lap is beside/in front of the face and only a short arc passes behind
        // (occluded by the person mask). ~6.5 s per lap, phase per side.
        const ph = tSec * 0.95 + (side === "left" ? 0 : Math.PI);
        out.orbit = add(body.head.p, [Math.cos(ph) * 0.34, 0.12 + Math.sin(ph * 2) * 0.04, 0.1 + Math.sin(ph) * 0.28]);
    }
    const wrist = [j.leftWrist, j.rightWrist].filter((w) => w.conf > 0.5).sort((a, b) => a.p[0] - b.p[0]);
    // Only a hand raised above the shoulders is a perch.
    const shoulderY = shoulders.length ? Math.max(...shoulders.map((s) => s.p[1])) : Infinity;
    for (const [i, w] of wrist.entries()) {
        if (w.p[1] < shoulderY - 0.05) continue;
        const key: AnchorId = wrist.length === 2 ? (i === 0 ? "handL" : "handR") : w.p[0] < body.head.p[0] ? "handL" : "handR";
        out[key] = add(w.p, [0, 0.07, 0.02]);
    }
    return out;
}

/** Is `p` inside the visible frame (with a margin)? */
export function onScreen(pin: Pinhole, p: Vec3, margin = 0.04): boolean {
    const s = project(pin, p);
    return s.depthM > 0.2 && s.u > margin && s.u < 1 - margin && s.v > margin && s.v < 1 - margin;
}

export class PetRoamer {
    readonly #o: Required<RoamOptions>;
    readonly loco: Locomotion;
    #p: Vec3 | null = null;
    #v: Vec3 = [0, 0, 0];
    #yaw = 0;
    #pitch = 0;
    #anchor: AnchorId;
    #want: AnchorId | null = null;
    #since = 0;
    #dwell: number;
    #settled = false;
    #hopT = -1;
    #hopFrom: Vec3 | null = null;
    #path: Vec3[] = [];
    /** Last position of each anchor and when it was last valid (grace through dropouts). */
    readonly #lastSeen = new Map<AnchorId, { p: Vec3; at: number }>();

    constructor(o: RoamOptions) {
        this.#o = { rand: Math.random, ...o };
        this.loco = locomotionOf(o.family);
        this.#anchor = o.side === "left" ? "shoulderL" : "shoulderR";
        this.#dwell = DWELL_MS * (0.6 + this.#o.rand() * 0.8);
    }

    get anchor(): AnchorId {
        return this.#anchor;
    }

    /** Ask for an anchor (gesture reactions, gifts). It is honoured as soon as the anchor is valid. */
    request(anchor: AnchorId): void {
        this.#want = anchor;
    }

    /**
     * The mind's choice of anchor (utility AI). When set, it replaces the built-in
     * preference list; the roamer still validates it (off-screen / missing anchors
     * fall back with grace), and explicit `request()`s (gestures) still win.
     */
    direct(anchor: AnchorId | null): void {
        this.#directed = anchor;
    }

    /** Positions of every anchor this frame (for the mind's availability check). */
    get anchors(): Readonly<Record<AnchorId, Vec3 | null>> | null {
        return this.#lastAnchors;
    }

    /** Apply a hard-constraint correction (metres) after `update`; keeps steering consistent. */
    nudge(delta: Vec3): void {
        if (!this.#p) return;
        this.#p = [this.#p[0] + delta[0], this.#p[1] + delta[1], this.#p[2] + delta[2]];
        if (this.#hopFrom) this.#hopFrom = [this.#hopFrom[0] + delta[0], this.#hopFrom[1] + delta[1], this.#hopFrom[2] + delta[2]];
    }

    get position(): Vec3 | null {
        return this.#p;
    }

    #directed: AnchorId | null = null;
    #lastAnchors: Record<AnchorId, Vec3 | null> | null = null;

    /** Ranked anchors this pet prefers, by locomotion and side. */
    #preferred(): AnchorId[] {
        const own = this.#o.side === "left" ? "shoulderL" : "shoulderR";
        const other = this.#o.side === "left" ? "shoulderR" : "shoulderL";
        const ledge = this.#o.side === "left" ? "ledgeL" : "ledgeR";
        const hand = this.#o.side === "left" ? "handL" : "handR";
        if (this.loco === "walk") return [own, hand, ledge, other];
        return [own, "crown", hand, "orbit", other, ledge];
    }

    #choose(a: Record<AnchorId, Vec3 | null>, pin: Pinhole, now: number): AnchorId {
        if (this.#want) {
            const w = this.#want;
            if (a[w] && onScreen(pin, a[w]) || w === "orbit" && a.orbit) {
                return w;
            }
        }
        const valid = (id: AnchorId) => {
            const p = a[id];
            return !!p && (id === "orbit" || onScreen(pin, p));
        };
        // Grace: the current anchor survives short dropouts (pose at 8-30 Hz, low-visibility frames).
        const current = this.#anchor;
        const seen = this.#lastSeen.get(current);
        const currentOk = valid(current) || (!!seen && now - seen.at < ANCHOR_GRACE_MS);
        const ownSide = (id: AnchorId) => !id.endsWith(this.#o.side === "left" ? "R" : "L");
        // Mind-directed: go where the utility AI decided, if that anchor exists now (or recently).
        const d = this.#directed;
        if (d) {
            const dSeen = this.#lastSeen.get(d);
            if (valid(d) || (d === current && !!dSeen && now - dSeen.at < ANCHOR_GRACE_MS)) return d;
        }
        // Stay while the current anchor is valid and the dwell has not run out.
        if (currentOk && (now - this.#since < this.#dwell || current.startsWith("ledge"))) {
            if (!current.startsWith("ledge")) return current;
            // On a ledge: leave for a real perch on OUR side as soon as one appears.
            const better = this.#preferred().find((id) => !id.startsWith("ledge") && id !== "orbit" && ownSide(id) && valid(id));
            return better ?? current;
        }
        const pref = this.#preferred();
        // Variety after a dwell: occasionally pick the 2nd valid choice (fliers may orbit).
        const valids = pref.filter(valid);
        if (valids.length === 0) return this.#o.side === "left" ? "ledgeL" : "ledgeR";
        const first = valids[0] as AnchorId;
        if (now - this.#since >= this.#dwell && valids.length > 1 && this.#o.rand() < 0.45) return valids[1] as AnchorId;
        return first;
    }

    /**
     * Advance to `nowMs`. `body` null = nobody tracked. `pointAt` = where the owner points (or null).
     */
    update(body: BodySnapshot | null, pin: Pinhole, nowMs: number, dtSec: number, pointAt: Vec3 | null = null): PetPose {
        const dt = Math.min(Math.max(dtSec, 0), 0.1);
        const tSec = nowMs / 1000;
        const a = anchorPoints(body, pin, this.#o.side, tSec, pointAt);
        this.#lastAnchors = a;
        for (const id of ANCHORS) {
            const q = a[id];
            if (q) this.#lastSeen.set(id, { p: q, at: nowMs });
        }
        const next = this.#choose(a, pin, nowMs);
        if (next !== this.#anchor) {
            this.#anchor = next;
            this.#since = nowMs;
            this.#settled = false;
            this.#dwell = DWELL_MS * (0.6 + this.#o.rand() * 0.8);
            if (this.#want === next) this.#want = null;
        }
        if (this.#want === "centre" && this.#anchor === "centre" && nowMs - this.#since > 4000) this.#want = null;
        const target = a[this.#anchor] ?? this.#lastSeen.get(this.#anchor)?.p ?? a.ledgeL ?? ([0, -0.5, -1] as Vec3);
        if (!this.#p) this.#p = [...target];
        const p = this.#p;

        const lim = LIMITS[this.loco];
        const toT = sub(target, p);
        const dist = len(toT);
        let gait: PetPose["gait"] = null;
        let gaitWeight = 0;

        // Orbit is a moving target: follow it continuously, never "settle".
        const moving = this.#anchor === "orbit";
        if (this.#settled && dist < 0.12 && !moving) {
            // Perched: follow the anchor rigidly (the body moves the pet), with a short spring.
            const k = 1 - Math.exp(-dt / 0.05);
            this.#p = lerp3(p, target, k);
            this.#v = [0, 0, 0];
        } else {
            this.#settled = false;
            // Walkers jump between disjoint perches: a ballistic hop instead of walking on air.
            if (this.loco === "walk" && dist > 0.12 && this.#hopT < 0) {
                this.#hopT = 0;
                this.#hopFrom = [...p];
            }
            if (this.#hopT >= 0) {
                const start = this.#hopFrom ?? p;
                const span = len(sub(target, start));
                const dur = Math.min(0.35 + span * 0.6, 0.9);
                this.#hopT += dt / dur;
                const t = Math.min(this.#hopT, 1);
                // Arc height from the fixed start, capped so a long jump never leaves the frame.
                const arc = Math.min(Math.max(0.08, span * 0.35), 0.25);
                const base = lerp3(start, target, t);
                this.#p = [base[0], base[1] + Math.sin(Math.PI * t) * arc, base[2]];
                gait = "hop";
                gaitWeight = 1;
                if (t >= 1) {
                    this.#hopT = -1;
                    this.#hopFrom = null;
                    this.#settled = true;
                }
            } else {
                // Arrive steering: desired velocity slows inside the brake radius.
                const brake = (lim.speed * lim.speed) / (2 * lim.accel);
                const speed = dist > brake ? lim.speed : lim.speed * Math.sqrt(dist / Math.max(brake, 1e-3));
                const desired = dist > 1e-5 ? mul(toT, speed / dist) : ([0, 0, 0] as Vec3);
                const dv = sub(desired, this.#v);
                const dvl = len(dv);
                const maxDv = lim.accel * dt;
                this.#v = add(this.#v, dvl > maxDv ? mul(dv, maxDv / dvl) : dv);
                this.#p = add(p, mul(this.#v, dt));
                const sp = len(this.#v);
                if (this.loco === "walk") {
                    gait = sp > 0.02 ? "walk" : null;
                    gaitWeight = Math.min(sp / 0.15, 1);
                } else {
                    gait = sp > 0.05 || this.#anchor === "orbit" ? "fly" : null;
                    gaitWeight = this.#anchor === "orbit" ? 1 : Math.min(sp / 0.3, 1);
                }
                if (!moving && dist < ARRIVE_M && sp < 0.05) this.#settled = true;
            }
        }
        if (!this.#settled && this.#hopT < 0 && this.#path.length === 0) this.#path = [p];
        if (this.#settled) this.#path = [];
        if (this.#path.length > 0) this.#path = [this.#path[0] as Vec3, target];

        // Facing: travel direction while moving fast, else towards the camera with a slight turn to the owner.
        const pos = this.#p;
        const vel = this.#v;
        const sp = Math.hypot(vel[0], vel[2]);
        let wantYaw: number;
        if (sp > 0.08) wantYaw = Math.atan2(vel[0], vel[2]);
        else {
            // Face the camera (the viewers), turned a third of the way towards the owner.
            const toCam = Math.atan2(0 - pos[0], 0 - pos[2]);
            const head = body?.present ? body.head.p : null;
            const toHead = head ? Math.atan2(head[0] - pos[0], head[2] - pos[2]) : toCam;
            wantYaw = toCam + angleDelta(toCam, toHead) * 0.33;
        }
        this.#yaw += angleDelta(this.#yaw, wantYaw) * (1 - Math.exp(-dt / 0.18));
        const wantPitch = this.loco === "walk" ? 0 : Math.max(-0.5, Math.min(0.5, -vel[1] * 0.4 + sp * 0.25));
        this.#pitch += (wantPitch - this.#pitch) * (1 - Math.exp(-dt / 0.15));
        const camera: Vec3 = [0, pin.heightM ?? 0, 0];
        const lookAt: Vec3 = body?.present && body.head.conf > 0.3 ? lookTarget(body, camera, nowMs, this.#o.side === "left" ? 0 : 1.5) : camera;
        return {
            p: pos,
            yaw: this.#yaw,
            pitch: this.#pitch,
            roll: 0,
            gait,
            gaitWeight,
            anchor: this.#anchor,
            settled: this.#settled,
            lookAt,
            alpha: 1,
            path: this.#path,
        };
    }
}

/**
 * Alternate gaze between the owner's face and the camera (the viewers): one
 * camera glance in three slots of ~3.7 s. The slot index is time-based only,
 * so the target is piecewise constant (no per-frame jitter).
 */
export function lookTarget(body: BodySnapshot, camera: Vec3, nowMs: number, phaseOffset = 0): Vec3 {
    const slot = Math.floor(nowMs / 3700 + phaseOffset) % 3;
    if (slot === 0) return camera;
    return add(body.head.p, [0, 0.03, 0.05]);
}
