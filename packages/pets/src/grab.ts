import type { Vec3 } from "./space.js";

/**
 * Pick a pet up with a pinch, move it, resize it with a second pinch. Pure,
 * clock-injected (ms), allocation-light; the stage feeds it once per frame.
 *
 *   grab    a pinching hand within max(0.12 m, 1.6 x radius) of a pet (nearest
 *           wins), pinch held >= 50 ms. The pet keeps its initial offset to the
 *           pinch point, decaying to 0 over 250 ms (it snaps into the fingers);
 *           the target is a critically damped spring (tau 0.04 s).
 *   dropout the holding hand missing for < 120 ms keeps the grab.
 *   release unpinch (or the hand gone >= 120 ms).
 *   resize  while held, the OTHER hand pinches anywhere: scale = clamp(start x
 *           dist / dist0, 0.4, 2.5), smoothed; ends when that hand unpinches,
 *           the scale is kept.
 */

export type HandSide = "left" | "right";

export interface HandInput {
    side: HandSide;
    present: boolean;
    pinching: boolean;
    /** Pinch point (thumb/index midpoint), world metres. */
    point: Vec3;
    /** 0..1 pinch strength (informational). */
    strength: number;
}

export interface GrabPet {
    id: string;
    /** Body centre (or contact point) the grab radius is measured from, metres. */
    p: Vec3;
    radiusM: number;
    /** Current size multiplier (resize starts from it); default 1. */
    scale?: number;
}

export type GrabMode = "drag" | "resize";

export interface GrabHeld {
    pet: string;
    mode: GrabMode;
    target: Vec3;
    scale: number;
}

export type GrabEventKind = "grab" | "drop" | "resizeStart" | "resizeEnd";

export interface GrabEvent {
    kind: GrabEventKind;
    pet: string;
    scale: number;
}

export interface GrabOutput {
    held: GrabHeld | null;
    events: GrabEvent[];
}

export const GRAB_MIN_RADIUS_M = 0.12;
export const GRAB_RADIUS_K = 1.6;
export const GRAB_HOLD_MS = 50;
export const GRAB_DROPOUT_MS = 120;
export const GRAB_SNAP_MS = 250;
export const GRAB_TAU_S = 0.04;
export const PET_SCALE_MIN = 0.4;
export const PET_SCALE_MAX = 2.5;
const SCALE_TAU_S = 0.08;

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const other = (s: HandSide): HandSide => (s === "left" ? "right" : "left");

interface Hold {
    pet: string;
    hand: HandSide;
    offset: Vec3;
    startMs: number;
    lastSeenMs: number;
    lastPoint: Vec3;
    /** Spring state (position, velocity). */
    p: Vec3;
    v: Vec3;
    scale: number;
    resize: { dist0: number; startScale: number; want: number } | null;
}

export class HandGrab {
    /** When each hand started pinching (null = not pinching). */
    readonly #pinchSince: Record<HandSide, number | null> = { left: null, right: null };
    /** A pinch that began while another action was running cannot grab until it is released. */
    readonly #spent: Record<HandSide, boolean> = { left: false, right: false };
    #hold: Hold | null = null;
    #lastMs: number | null = null;

    get held(): GrabHeld | null {
        const h = this.#hold;
        return h ? { pet: h.pet, mode: h.resize ? "resize" : "drag", target: [...h.p], scale: h.scale } : null;
    }

    /** Forget the grab (pet removed) without a drop event. */
    cancel(): void {
        this.#hold = null;
    }

    update(nowMs: number, hands: readonly HandInput[], pets: readonly GrabPet[]): GrabOutput {
        const dt = this.#lastMs === null ? 0 : clamp((nowMs - this.#lastMs) / 1000, 0, 0.1);
        this.#lastMs = nowMs;
        const events: GrabEvent[] = [];
        const bySide: Record<HandSide, HandInput | undefined> = { left: undefined, right: undefined };
        for (const h of hands) if (h.present && isVec(h.point)) bySide[h.side] = h;
        for (const side of ["left", "right"] as const) {
            const h = bySide[side];
            const pinching = !!h?.pinching;
            if (pinching && this.#pinchSince[side] === null) this.#pinchSince[side] = nowMs;
            // A missing hand keeps its pinch timer only while it is the holding hand (dropout grace).
            if (!pinching && !(h === undefined && this.#hold?.hand === side)) {
                this.#pinchSince[side] = null;
                this.#spent[side] = false;
            }
        }

        let hold = this.#hold;
        if (hold && !pets.some((p) => p.id === hold?.pet)) {
            this.#hold = null;
            hold = null;
        }
        if (hold) {
            const h = bySide[hold.hand];
            if (h) {
                hold.lastSeenMs = nowMs;
                hold.lastPoint = [...h.point];
            }
            const released = h ? !h.pinching : nowMs - hold.lastSeenMs >= GRAB_DROPOUT_MS;
            if (released) {
                if (hold.resize) events.push({ kind: "resizeEnd", pet: hold.pet, scale: hold.scale });
                events.push({ kind: "drop", pet: hold.pet, scale: hold.scale });
                this.#spent[hold.hand] = false;
                this.#spent[other(hold.hand)] = false;
                this.#hold = null;
                return { held: null, events };
            }
            this.#resize(hold, bySide, dt, events);
            // Offset decays linearly to 0 over the snap time.
            const k = Math.max(0, 1 - (nowMs - hold.startMs) / GRAB_SNAP_MS);
            const goal: Vec3 = [hold.lastPoint[0] + hold.offset[0] * k, hold.lastPoint[1] + hold.offset[1] * k, hold.lastPoint[2] + hold.offset[2] * k];
            dampedSpring3(hold.p, hold.v, goal, dt, GRAB_TAU_S);
            return { held: this.held, events };
        }

        // No grab: the first hand whose pinch has lasted >= 50 ms near a pet takes it.
        let best: { side: HandSide; pet: GrabPet; d: number } | null = null;
        for (const side of ["left", "right"] as const) {
            const h = bySide[side];
            const since = this.#pinchSince[side];
            if (!h?.pinching || since === null || this.#spent[side] || nowMs - since < GRAB_HOLD_MS) continue;
            for (const pet of pets) {
                const d = dist(h.point, pet.p);
                const reach = Math.max(GRAB_MIN_RADIUS_M, GRAB_RADIUS_K * pet.radiusM);
                if (d <= reach && (!best || d < best.d)) best = { side, pet, d };
            }
        }
        if (!best) return { held: null, events };
        const h = bySide[best.side] as HandInput;
        const p = best.pet;
        this.#hold = {
            pet: p.id,
            hand: best.side,
            offset: [p.p[0] - h.point[0], p.p[1] - h.point[1], p.p[2] - h.point[2]],
            startMs: nowMs,
            lastSeenMs: nowMs,
            lastPoint: [...h.point],
            p: [...p.p],
            v: [0, 0, 0],
            scale: clamp(p.scale ?? 1, PET_SCALE_MIN, PET_SCALE_MAX),
            resize: null,
        };
        // The other hand, if already pinching, must re-pinch to start a resize.
        if (bySide[other(best.side)]?.pinching) this.#spent[other(best.side)] = true;
        events.push({ kind: "grab", pet: p.id, scale: this.#hold.scale });
        return { held: this.held, events };
    }

    #resize(hold: Hold, bySide: Record<HandSide, HandInput | undefined>, dt: number, events: GrabEvent[]): void {
        const side = other(hold.hand);
        const h2 = bySide[side];
        const pinching = !!h2?.pinching && !this.#spent[side];
        if (hold.resize && !pinching) {
            hold.resize = null;
            events.push({ kind: "resizeEnd", pet: hold.pet, scale: hold.scale });
        } else if (!hold.resize && pinching && h2) {
            const d0 = dist(hold.lastPoint, h2.point);
            if (d0 > 0.01) {
                hold.resize = { dist0: d0, startScale: hold.scale, want: hold.scale };
                events.push({ kind: "resizeStart", pet: hold.pet, scale: hold.scale });
            }
        }
        if (hold.resize && h2) {
            const r = hold.resize;
            r.want = clamp((r.startScale * dist(hold.lastPoint, h2.point)) / r.dist0, PET_SCALE_MIN, PET_SCALE_MAX);
        }
        if (hold.resize) {
            const k = dt > 0 ? 1 - Math.exp(-dt / SCALE_TAU_S) : 0;
            hold.scale = clamp(hold.scale + (hold.resize.want - hold.scale) * k, PET_SCALE_MIN, PET_SCALE_MAX);
        }
    }
}

function isVec(v: Vec3): boolean {
    return Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
}

/** Critically damped spring toward `goal`, time constant `tau` (s); mutates p and v. */
export function dampedSpring3(p: Vec3, v: Vec3, goal: Vec3, dt: number, tau: number): void {
    if (!(dt > 0)) return;
    const w = 1 / tau;
    const e = Math.exp(-w * dt);
    for (let i = 0; i < 3; i++) {
        const x0 = (p[i] as number) - (goal[i] as number);
        const v0 = v[i] as number;
        const c = v0 + w * x0;
        p[i] = (goal[i] as number) + (x0 + c * dt) * e;
        v[i] = (c - w * (x0 + c * dt)) * e;
    }
}
