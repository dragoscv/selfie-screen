import type { AccentPreset, Appearance, SurfaceMode, ThemeMode } from "@tiksee/core";

/** OKLCH channels per accent preset. Must stay in sync with `theme.css`. */
export const ACCENT_CHANNELS: Readonly<Record<AccentPreset, { h: number; c: number }>> = {
    cyan: { h: 226, c: 0.13 },
    violet: { h: 293, c: 0.16 },
    amber: { h: 74, c: 0.14 },
    emerald: { h: 156, c: 0.14 },
    rose: { h: 16, c: 0.16 },
    sky: { h: 245, c: 0.15 },
};

export const ACCENT_LABELS: Readonly<Record<AccentPreset, string>> = {
    cyan: "Cyan",
    violet: "Violet",
    amber: "Amber",
    emerald: "Emerald",
    rose: "Rose",
    sky: "Sky",
};

/** A CSS colour for a preset swatch, independent of the current theme. */
export function accentSwatch(accent: AccentPreset, hue?: number, chroma?: number): string {
    const preset = ACCENT_CHANNELS[accent] ?? ACCENT_CHANNELS.cyan;
    return `oklch(0.68 ${chroma ?? preset.c} ${hue ?? preset.h})`;
}

/** Resolve `system` against the OS preference. */
export function resolveMode(mode: ThemeMode): "light" | "dark" {
    if (mode !== "system") return mode;
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export interface AppliedTheme {
    mode: "light" | "dark";
    surface: SurfaceMode;
}

/**
 * Write the appearance onto `<html>`.
 *
 * Three independent attributes rather than one composite class — that is what
 * keeps the CSS at O(mode + accent + surface) instead of the product of all
 * three, and lets a single axis change without touching the others.
 */
export function applyAppearance(appearance: Appearance): AppliedTheme {
    const root = document.documentElement;
    const mode = resolveMode(appearance.mode);

    root.classList.toggle("dark", mode === "dark");
    root.dataset.accent = appearance.accent;
    root.dataset.surface = appearance.surface;
    root.dataset.density = appearance.density;
    root.dataset.reducedMotion = String(appearance.reducedMotion);
    root.style.setProperty("--font-scale", String(appearance.fontScale));

    // A custom accent overrides the preset by writing the channels inline;
    // every derived token recomputes from them automatically.
    if (appearance.customAccentHue !== undefined) {
        root.style.setProperty("--accent-h", String(appearance.customAccentHue));
        root.style.setProperty("--accent-c", String(appearance.customAccentChroma ?? 0.15));
    } else {
        root.style.removeProperty("--accent-h");
        root.style.removeProperty("--accent-c");
    }

    return { mode, surface: appearance.surface };
}

/** Whether the surface mode expects the OS to paint the window background. */
export function wantsNativeBackdrop(surface: SurfaceMode): boolean {
    return surface === "mica" || surface === "glass";
}
