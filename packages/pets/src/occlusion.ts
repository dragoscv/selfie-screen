/** Distance band where the in-front/behind decision does not flip. */
export const OCCLUSION_HYSTERESIS_M = 0.1;
export const OCCLUSION_FADE_MS = 150;

/**
 * Whether the person is in front of an object at `objectM`, with hysteresis:
 * it flips to "in front" only once the person is `band` closer than the
 * object, and back only once `band` farther. Unknown distance keeps the
 * previous decision.
 */
export function personInFront(prev: boolean, personM: number | undefined, objectM: number, band = OCCLUSION_HYSTERESIS_M): boolean {
    if (personM === undefined || !Number.isFinite(personM)) return prev;
    if (prev) return personM < objectM + band;
    return personM < objectM - band;
}

/** Linear crossfade toward `target` (0/1) over `fadeMs`. */
export function fadeToward(value: number, target: number, dtMs: number, fadeMs = OCCLUSION_FADE_MS): number {
    const step = dtMs / Math.max(fadeMs, 1);
    return target > value ? Math.min(target, value + step) : Math.max(target, value - step);
}
