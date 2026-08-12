import type { Transition, Variants } from "motion/react";

/**
 * Shared motion tokens.
 *
 * Components import these instead of inventing durations, so the whole app
 * moves with one voice and a single edit changes the feel everywhere.
 * Values mirror the CSS custom properties in `theme.css`.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;

export const transitions = {
    instant: { duration: 0.11, ease: EASE_STANDARD },
    fast: { duration: 0.18, ease: EASE_OUT },
    normal: { duration: 0.24, ease: EASE_OUT },
    slow: { duration: 0.34, ease: EASE_OUT },
    /** For anything that should feel physical: drag, resize, reorder. */
    spring: { type: "spring", stiffness: 420, damping: 34, mass: 0.7 },
    springSoft: { type: "spring", stiffness: 260, damping: 28 },
} satisfies Record<string, Transition>;

/** Standard enter/exit for list rows (chat messages, notifications). */
export const rowVariants: Variants = {
    initial: { opacity: 0, y: 8, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1, transition: transitions.normal },
    exit: { opacity: 0, scale: 0.98, transition: transitions.fast },
};

/** Panels and cards appearing for the first time. */
export const panelVariants: Variants = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0, transition: transitions.normal },
    exit: { opacity: 0, y: -8, transition: transitions.fast },
};

/** Route-level crossfade. Deliberately subtle — this is a tool, not a demo. */
export const pageVariants: Variants = {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0, transition: transitions.normal },
    exit: { opacity: 0, y: -6, transition: transitions.fast },
};

/** Stagger helper for revealing a group of children in sequence. */
export function stagger(delayChildren = 0.04, staggerChildren = 0.035): Variants {
    return {
        initial: {},
        animate: { transition: { delayChildren, staggerChildren } },
    };
}
