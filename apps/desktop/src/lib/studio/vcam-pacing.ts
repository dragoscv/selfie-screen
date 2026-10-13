/**
 * Virtual camera pacing: a fixed frame grid instead of "last pump + period",
 * which drifted (each late rAF pushed every later deadline back).
 */

/**
 * Next pump deadline after pumping at `now`. Advances on the grid; when the
 * pump fell more than one period behind (a stall), re-anchors one period
 * before `now` so it never bursts to catch up.
 */
export function nextPumpDeadline(prev: number, now: number, period: number): number {
    return Math.max(prev + period, now - period);
}

/** Pump rate: the settings fps, capped by what the consumer negotiated when known. */
export function effectiveFps(settingsFps: number, consumerFps?: number): number {
    const base = settingsFps > 0 ? settingsFps : 30;
    return consumerFps !== undefined && consumerFps > 0 ? Math.min(base, consumerFps) : base;
}
