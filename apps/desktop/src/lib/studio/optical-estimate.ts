/** Lens speed relative to speed 2 (the travel time is measured at speed 2). */
const SPEED_RATE: Readonly<Record<1 | 2 | 3, number>> = { 1: 0.45, 2: 1, 3: 1.8 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lens position estimate 0 (wide) .. 1 (tele) from every zoom hold (dock buttons, rules and
 * zoom gestures alike): the BLE remote reports no lens position. Clamped at both ends, so
 * holding past an end re-syncs it with the lens.
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