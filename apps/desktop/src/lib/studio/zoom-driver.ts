/**
 * Turns a zoom gesture's wish into smooth lens + crop motion. A gesture (two-hand pinch, index
 * dial) says "log zoom offset from where I started"; the driver eases toward it with a speed
 * cap so the picture never jumps, drives the OPTICAL zoom first (BLE lens hold until its
 * estimated tele end), then the digital crop; zooming out unwinds the crop first, then the
 * lens. The BLE remote reports no lens position, so it is estimated (OpticalEstimate).
 */

export interface ZoomConfig {
    /** Drive the optical zoom first (needs the BLE remote). */
    optical: boolean;
    /** Optical range of the lens (tele / wide focal length), e.g. 16-50 mm = 3.1. */
    opticalMax: number;
    /** Digital crop limit. */
    digitalMax: number;
}

export interface ZoomContext {
    /** Estimated lens position 0 (wide) .. 1 (tele). */
    opticalPos: number;
    /** BLE remote connected. */
    opticalReady: boolean;
    /** Current digital zoom target. */
    digital: number;
}

export type OpticalCommand = { action: "zoomIn" | "zoomOut"; speed: 1 | 2 } | null;

export interface ZoomStep {
    /** Lens hold to apply now (null = release). */
    optical: OpticalCommand;
    /** New digital zoom, or null to leave it. */
    digital: number | null;
    /** Total zoom being shown/asked (optical x digital), for the readout. */
    target: number;
}

/** Fastest the zoom may change: ln units per second (0.7 = about x2 per second). */
export const ZOOM_RATE_MAX = 0.7;
/** Easing toward the gesture's wish (s): removes hand jitter without feeling laggy. */
export const ZOOM_EASE_S = 0.18;
/** Log band: start driving the lens above START, stop below STOP (hysteresis). */
const BAND_START = 0.05;
const BAND_STOP = 0.02;
/** Squeezing below 1x keeps driving the lens wide (re-syncs the estimate at the wide end). */
const TARGET_MIN = 0.8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const opticalFactor = (pos: number, max: number) => Math.pow(Math.max(1, max), clamp(pos, 0, 1));

/** Lens speed: 1 for fine moves, 2 when far behind; never the remote's fastest (3). */
export function opticalSpeed(err: number): 1 | 2 {
    return Math.abs(err) > 0.3 ? 2 : 1;
}

export class ZoomDriver {
    #z0 = 1;
    /** Eased, speed-capped log offset actually applied. */
    #log = 0;
    #driving: OpticalCommand = null;

    /** Start a gesture from the zoom shown now. */
    begin(ctx: ZoomContext, cfg: ZoomConfig): void {
        this.#z0 = this.total(ctx, cfg);
        this.#log = 0;
        this.#driving = null;
    }

    total(ctx: ZoomContext, cfg: ZoomConfig): number {
        const optMax = cfg.optical && ctx.opticalReady ? cfg.opticalMax : 1;
        return opticalFactor(ctx.opticalPos, optMax) * ctx.digital;
    }

    /** One frame: `wish` = log zoom offset the gesture asks for since `begin`. */
    step(wish: number, dtSec: number, ctx: ZoomContext, cfg: ZoomConfig): ZoomStep {
        const optMax = cfg.optical && ctx.opticalReady ? cfg.opticalMax : 1;
        const lo = Math.log(TARGET_MIN / this.#z0);
        const hi = Math.log((optMax * cfg.digitalMax) / this.#z0);
        const want = clamp(wish, lo, hi);
        const eased = (want - this.#log) * (1 - Math.exp(-dtSec / ZOOM_EASE_S));
        this.#log += clamp(eased, -ZOOM_RATE_MAX * dtSec, ZOOM_RATE_MAX * dtSec);
        const total = this.#z0 * Math.exp(this.#log);
        const optF = opticalFactor(ctx.opticalPos, optMax);
        const current = optF * ctx.digital;
        const err = Math.log(total / Math.max(current, 1e-6));
        const band = this.#driving ? BAND_STOP : BAND_START;
        let optical: OpticalCommand = null;
        let digital: number | null = null;
        if (err > band) {
            if (optMax > 1 && ctx.opticalPos < 1) optical = { action: "zoomIn", speed: opticalSpeed(err) };
            else digital = clamp(total / optF, 1, cfg.digitalMax);
        } else if (err < -band) {
            if (ctx.digital > 1.001) digital = clamp(total / optF, 1, cfg.digitalMax);
            else if (optMax > 1) optical = { action: "zoomOut", speed: opticalSpeed(err) };
        } else if (optMax <= 1 || ctx.opticalPos >= 1 || ctx.digital > 1.001) {
            // Inside the band on the crop: keep following the eased target exactly (smooth crop).
            digital = clamp(total / optF, 1, cfg.digitalMax);
        }
        this.#driving = optical;
        return { optical, digital, target: Math.max(1, total) };
    }
}
