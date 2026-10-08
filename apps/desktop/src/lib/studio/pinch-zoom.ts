/**
 * Two-hand pinch zoom: both hands pinched, pull them apart = zoom in, bring them together =
 * zoom out. Gives the ZoomDriver a log offset: GAIN x ln(distance / start distance), so the
 * zoom follows the hands like pinch-to-zoom on a phone but gentler (doubling the distance
 * zooms ~1.5x), and the driver eases and caps the speed.
 */

export type Vec3 = readonly [number, number, number];

export interface PinchHand {
    present: boolean;
    pinching: boolean;
    /** Pinch point (thumb/index midpoint), world metres. */
    point: Vec3;
}

export interface PinchState {
    active: boolean;
    /** The gesture started this frame (begin the driver from the zoom shown now). */
    started: boolean;
    /** Log zoom offset since the start. */
    wish: number;
    /** The gesture ended this frame. */
    ended: boolean;
}

/** Both hands must pinch this long before the gesture starts (no accidental zoom). */
export const PINCH_ZOOM_START_MS = 150;
/** Pinch flicker tolerated before the gesture ends. */
export const PINCH_ZOOM_GRACE_MS = 250;
/** Hands closer than this at the start are too close to measure a ratio reliably. */
export const PINCH_ZOOM_MIN_START_M = 0.06;
/** ln(zoom) per ln(distance ratio): doubling the hand distance = x1.5 zoom. */
export const PINCH_ZOOM_GAIN = 0.6;
/** Distance changes smaller than this (ln ratio) are hand tremor, ignored. */
const DEAD_BAND = 0.04;

const IDLE: PinchState = { active: false, started: false, wish: 0, ended: false };
const span = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class PinchZoom {
    #bothSince = -Infinity;
    #lastBoth = -Infinity;
    #active = false;
    #d0 = 0;
    #wish = 0;

    get active(): boolean {
        return this.#active;
    }

    update(nowMs: number, hands: readonly PinchHand[], blocked: boolean): PinchState {
        const pinched = hands.filter((h) => h.present && h.pinching);
        const both = pinched.length >= 2;
        if (both) {
            this.#lastBoth = nowMs;
            if (this.#bothSince === -Infinity) this.#bothSince = nowMs;
        } else if (nowMs - this.#lastBoth > PINCH_ZOOM_GRACE_MS) this.#bothSince = -Infinity;

        const [a, b] = pinched;
        let started = false;
        if (!this.#active) {
            if (!both || !a || !b || blocked || nowMs - this.#bothSince < PINCH_ZOOM_START_MS) return IDLE;
            const d = span(a.point, b.point);
            if (d < PINCH_ZOOM_MIN_START_M) return IDLE;
            this.#active = true;
            this.#d0 = d;
            this.#wish = 0;
            started = true;
        }
        if (!both && nowMs - this.#lastBoth > PINCH_ZOOM_GRACE_MS) {
            this.#active = false;
            return { active: false, started: false, wish: this.#wish, ended: true };
        }
        if (a && b) {
            const lr = Math.log(span(a.point, b.point) / this.#d0);
            // Dead band around the start distance, then continuous (no jump at its edge).
            this.#wish = PINCH_ZOOM_GAIN * Math.sign(lr) * Math.max(0, Math.abs(lr) - DEAD_BAND);
        }
        return { active: true, started, wish: this.#wish, ended: false };
    }

    reset(): void {
        this.#active = false;
        this.#bothSince = -Infinity;
        this.#lastBoth = -Infinity;
    }
}
