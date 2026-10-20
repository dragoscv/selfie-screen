import type { StudioSettings } from "@tiksee/core";

/** Digital image controls shown in the Studio Look panel and Settings → Filters (same order, same ranges). */
export type LookKey = "exposure" | "brightness" | "contrast" | "highlights" | "shadows" | "warmth" | "tint" | "saturation" | "vibrance" | "sharpness";

export interface LookControl {
    key: LookKey;
    min: number;
    max: number;
    step: number;
    format: (v: number) => string;
}

const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;

export const LOOK_CONTROLS: readonly LookControl[] = [
    { key: "exposure", min: -2, max: 2, step: 0.05, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV` },
    { key: "brightness", min: -1, max: 1, step: 0.02, format: signed },
    { key: "contrast", min: -1, max: 1, step: 0.02, format: signed },
    { key: "highlights", min: -1, max: 1, step: 0.02, format: signed },
    { key: "shadows", min: -1, max: 1, step: 0.02, format: signed },
    { key: "warmth", min: -1, max: 1, step: 0.02, format: signed },
    { key: "tint", min: -1, max: 1, step: 0.02, format: signed },
    { key: "saturation", min: -1, max: 1, step: 0.02, format: signed },
    { key: "vibrance", min: -1, max: 1, step: 0.02, format: signed },
    { key: "sharpness", min: 0, max: 1, step: 0.02, format: (v) => `${Math.round(v * 100)}%` },
];

/** Every look control back to 0 (untouched camera). */
export const LOOK_RESET: Pick<StudioSettings, LookKey> = {
    exposure: 0,
    brightness: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    warmth: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    sharpness: 0,
};

export function lookIsDefault(s: Pick<StudioSettings, LookKey>): boolean {
    return LOOK_CONTROLS.every((c) => s[c.key] === 0);
}
