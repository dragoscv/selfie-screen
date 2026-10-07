/**
 * Two-hand pinch zoom: both hands pinched, pull them apart = zoom in, bring them together =
 * zoom out. The total zoom follows the hand distance relative to where the gesture started
 * (position control, like pinch-to-zoom on a phone). Optical comes FIRST: zooming in drives
 * the lens (BLE hold) until its estimated tele end, then the digital crop takes over; zooming
 * out unwinds the crop first, then the lens. The BLE remote reports no lens position, so the
 * lens position is estimated from how long and how fast zoom was held (OpticalEstimate).
 */

export type Vec3 = readonly [number, number, number];

export interface PinchHand {
    present: boolean;
    pinching: boolean;
    /** Pinch point (thumb/index midpoint), world metres. */
    point: Vec3;
}

export interface PinchZoomConfig {
    /** Drive the optical zoom first (needs the BLE remote). */
    optical: boolean;
    /** Optical range of the lens (tele / wide focal length), e.g. 16-50 mm = 3.1. */
    opticalMax: number;
    /** Digital crop limit. */
    digitalMax: number;
    /** Zoom = (hand distance / start distance) ^ gain. */
    gain: number;
}

export interface PinchZoomContext {
    /** Estimated lens position 0 (wide) .. 1 (tele). */
    opticalPos: number;
    /** BLE remote connected and optical enabled. */
    opticalReady: boolean;
    /** Current digital zoom target. */
    digital: number;
    /** Something else owns the pinch (a pet is held): never start. */
    blocked: boolean;
}

export type OpticalCommand = { action: "zoomIn" | "zoomOut"; speed: 1 | 2 | 3 } | null;

export interface PinchZoomResult {
    active: boolean;
    /** Lens hold to apply now (null = release). */
    optical: OpticalCommand;
    /** New digital zoom, or null to leave it. */
    digital: number | null;
    /** Total zoom the hands ask for (optical x digital), for the readout. */
    target: number;
    /** The gesture just ended this frame (persist the digital zoom). */
    ended: boolean;
}

/** Both hands must pinch this long before the gesture starts (no accidental zoom). */
export const PINCH_ZOOM_START_MS = 120;
/** Pinch flicker tolerated before the gesture ends. */
export const PINCH_ZOOM_GRACE_MS = 220;
/** Hands closer than this at the start are too close to measure a ratio reliably. */
export const PINCH_ZOOM_MIN_START_M = 0.06;
/** Log-ratio band: start driving the lens above START, stop below STOP (hysteresis). */
const BAND_START = 0.06;
const BAND_STOP = 0.025;
/** Squeezing below 1x keeps driving the lens wide (re-syncs the estimate at the wide end). */
const TARGET_MIN = 0.7;
const SMOOTH_TAU_S = 0.08;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const opticalFactor = (pos: number, max: number) => Math.pow(Math.max(1, max), clamp(pos, 0, 1));
const span = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Lens speed from how far the zoom is from where the hands want it (log units). */
export function opticalSpeed(err: number): 1 | 2 | 3 {
    const e = Math.abs(err);
    return e > 0.6 ? 3 : e > 0.25 ? 2 : 1;
}

export class PinchZoom {
    #bothSince = -Infinity;
    #lastBoth = -Infinity;
    #active = false;
    #d0 = 0;
    #z0 = 1;
    #ratio = 1;
    #lastT = 0;
    #driving: OpticalCommand = null;

    get active(): boolean {
        return this.#active;
    }

    update(nowMs: number, hands: readonly PinchHand[], ctx: PinchZoomContext, cfg: PinchZoomConfig): PinchZoomResult {
        const dt = clamp((nowMs - this.#lastT) / 1000, 0, 0.1);
        this.#lastT = nowMs;
        const pinched = hands.filter((h) => h.present && h.pinching);
        const both = pinched.length >= 2;
        const optMax = cfg.optical && ctx.opticalReady ? cfg.opticalMax : 1;
        const current = opticalFactor(ctx.opticalPos, optMax) * ctx.digital;
        const idle: PinchZoomResult = { active: false, optical: null, digital: null, target: current, ended: false };

        if (both) {
            this.#lastBoth = nowMs;
            if (this.#bothSince === -Infinity) this.#bothSince = nowMs;
        } else if (nowMs - this.#lastBoth > PINCH_ZOOM_GRACE_MS) this.#bothSince = -Infinity;

        if (!this.#active) {
            const [a, b] = pinched;
            if (!both || !a || !b || ctx.blocked || nowMs - this.#bothSince < PINCH_ZOOM_START_MS) return idle;
            const d = span(a.point, b.point);
            if (d < PINCH_ZOOM_MIN_START_M) return idle;
            this.#active = true;
            this.#d0 = d;
            this.#z0 = current;
            this.#ratio = 1;
            this.#driving = null;
        }

        if (!both && nowMs - this.#lastBoth > PINCH_ZOOM_GRACE_MS) {
            this.#active = false;
            this.#driving = null;
            return { ...idle, ended: true };
        }

        const [a, b] = pinched;
        if (a && b) {
            const raw = span(a.point, b.point) / this.#d0;
            this.#ratio += (raw - this.#ratio) * (1 - Math.exp(-dt / SMOOTH_TAU_S));
        }
        const total = clamp(this.#z0 * Math.pow(Math.max(this.#ratio, 0.05), cfg.gain), TARGET_MIN, optMax * cfg.digitalMax);
        const err = Math.log(total / Math.max(current, 1e-6));
        const band = this.#driving ? BAND_STOP : BAND_START;
        const optF = opticalFactor(ctx.opticalPos, optMax);
        let optical: OpticalCommand = null;
        let digital: number | null = null;

        if (err > band) {
            // In: the lens first, then the crop once the lens is at its tele end.
            if (optMax > 1 && ctx.opticalPos < 1) optical = { action: "zoomIn", speed: opticalSpeed(err) };
            else digital = clamp(total / optF, 1, cfg.digitalMax);
        } else if (err < -band) {
            // Out: unwind the crop first, then the lens.
            if (ctx.digital > 1.001) digital = clamp(total / optF, 1, cfg.digitalMax);
            else if (optMax > 1) optical = { action: "zoomOut", speed: opticalSpeed(err) };
        }
        this.#driving = optical;
        return { active: true, optical, digital, target: Math.max(1, total), ended: false };
    }

    reset(): void {
        this.#active = false;
        this.#bothSince = -Infinity;
        this.#lastBoth = -Infinity;
        this.#driving = null;
    }
}

/** Lens speed relative to speed 2 (the travel time is measured at speed 2). */
const SPEED_RATE: Readonly<Record<1 | 2 | 3, number>> = { 1: 0.45, 2: 1, 3: 1.8 };

/**
 * Lens position estimate 0 (wide) .. 1 (tele) from every zoom hold (dock buttons, rules and
 * pinch zoom alike). Clamped at both ends, so holding past an end re-syncs it with the lens.
 */
export class OpticalEstimate {
    #pos = 0;
    #held: { dir: 1 | -1; speed: 1 | 2 | 3; since: number } | null = null;
    travelMs = 3000;

    position(nowMs: number): number {
        const h = this.#held;
        if (!h) return this.#pos;
        return clamp(this.#pos + (h.dir * SPEED_RATE[h.speed] * (nowMs - h.since)) / Math.max(this.travelMs, 1), 0, 1);
    }

    hold(dir: 1 | -1, speed: 1 | 2 | 3, nowMs: number): void {
        this.#pos = this.position(nowMs);
        this.#held = { dir, speed, since: nowMs };
    }

    release(nowMs: number): void {
        this.#pos = this.position(nowMs);
        this.#held = null;
    }
}
