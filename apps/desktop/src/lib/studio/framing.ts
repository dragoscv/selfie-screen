import type { FramingSettings } from "@tiksee/core";
import { coverFraming, cropFraming, type Framing } from "@tiksee/pets";

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.25;
/** Fraction of the crop height kept above the top of the head. */
export const HEADROOM = 0.1;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Critically damped spring (no overshoot). `omega` = natural frequency in rad/s;
 * the step is exact for any dt (closed form), so frame drops do not destabilise it.
 */
export class Spring {
    value: number;
    velocity = 0;
    readonly omega: number;

    constructor(value: number, omega = 6) {
        this.value = value;
        this.omega = omega;
    }

    step(target: number, dtSec: number): number {
        const w = this.omega;
        const x0 = this.value - target;
        const e = Math.exp(-w * dtSec);
        const c = this.velocity + w * x0;
        this.value = target + (x0 + c * dtSec) * e;
        this.velocity = (c - w * (x0 + c * dtSec)) * e;
        return this.value;
    }

    snap(value: number): void {
        this.value = value;
        this.velocity = 0;
    }
}

/** Subject the framing follows, in UPRIGHT camera coords (0..1, y down). */
export interface FramingSubject {
    /** Face centre and size; null when nobody is seen. */
    face: { x: number; y: number; w: number; h: number } | null;
    /** Every person's box (faces or pose extents), for smart-wide. */
    people: number;
    standing: boolean;
}

/**
 * Digital zoom + auto-reframe on top of the cover crop. Output: a Framing the
 * Backdrop samples with, clamped to stay inside the camera image.
 */
export class DigitalFraming {
    readonly #zoom = new Spring(1, 8);
    readonly #cx = new Spring(0.5, 5);
    readonly #cy = new Spring(0.5, 5);
    #targetZoom = 1;
    #goal: [number, number] = [0.5, 0.5];
    #current: Framing = coverFraming(1, 1, 1, 1, false);

    get framing(): Framing {
        return this.#current;
    }

    get zoom(): number {
        return this.#zoom.value;
    }

    /** Animate toward a zoom (clamped 1..2.5). */
    setZoom(z: number): void {
        this.#targetZoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
    }

    stepZoom(dir: 1 | -1): number {
        this.setZoom(Math.round((this.#targetZoom + dir * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP);
        return this.#targetZoom;
    }

    get targetZoom(): number {
        return this.#targetZoom;
    }

    /**
     * Advance one frame. `base` = cover framing for the current camera/output;
     * returns the cropped framing.
     */
    update(base: Framing, settings: FramingSettings, subject: FramingSubject, dtSec: number): Framing {
        // Smart wide: two people or standing up -> back to 1x so everyone fits.
        const wide = settings.smartWide && (subject.people >= 2 || subject.standing);
        const z = this.#zoom.step(wide ? 1 : this.#targetZoom, dtSec);
        const winW = base.scaleX / z;
        const winH = base.scaleY / z;
        let [gx, gy] = this.#goal;
        if (settings.autoReframe && subject.face && !wide) {
            const f = subject.face;
            // Keep the eyes about a third down, and at least HEADROOM above the head.
            const wantY = Math.min(f.y + winH * (0.5 - 1 / 3), f.y - f.h / 2 - winH * HEADROOM + winH / 2);
            const dx = f.x - gx;
            const dy = wantY - gy;
            const dz = settings.deadZone;
            if (Math.abs(dx) > dz * winW) gx = f.x - Math.sign(dx) * dz * winW;
            if (Math.abs(dy) > dz * winH) gy = wantY - Math.sign(dy) * dz * winH;
        } else if (!settings.autoReframe || wide) {
            gx = base.offsetX + base.scaleX / 2;
            gy = base.offsetY + base.scaleY / 2;
        }
        // Clamp the goal so the window never leaves the image (the spring then never pushes against the edge).
        gx = clamp(gx, winW / 2, 1 - winW / 2);
        gy = clamp(gy, winH / 2, 1 - winH / 2);
        this.#goal = [gx, gy];
        const cx = this.#cx.step(gx, dtSec);
        const cy = this.#cy.step(gy, dtSec);
        this.#current = cropFraming(base, z, cx, cy);
        return this.#current;
    }
}
