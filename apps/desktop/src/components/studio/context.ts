import type { AudioSettings, IdentityProfile, StudioSettings, VisionSettings, VoiceSettings } from "@tiksee/core";
import { createContext, useContext, useState, useSyncExternalStore } from "react";

import type { StudioController, StudioFrameInfo } from "../../lib/studio/controller.js";
import type { Rect } from "./geometry.js";

/**
 * Latest per-frame info (~15 Hz) outside React. Components subscribe with a
 * selector that returns a primitive or an existing reference, so only the
 * overlays whose field actually changed re-render.
 */
export class FrameStore {
    #info: StudioFrameInfo | null = null;
    readonly #subs = new Set<() => void>();

    get = (): StudioFrameInfo | null => this.#info;

    set(info: StudioFrameInfo): void {
        this.#info = info;
        for (const cb of this.#subs) cb();
    }

    subscribe = (cb: () => void): (() => void) => {
        this.#subs.add(cb);
        return () => this.#subs.delete(cb);
    };
}

export function useFrame<T>(store: FrameStore, select: (info: StudioFrameInfo | null) => T): T {
    return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(null));
}

/**
 * Presence hysteresis for per-frame lists (faces, dogs, gesture hints).
 * Detections drop out for a frame or two all the time; without this every
 * dropout unmounted the element and the next frame mounted it again, which
 * the owner saw as fast flicker (2026-10-06). An item appears only after it
 * has been seen for `showMs` and stays (at its last position) until it has
 * been missing for `hideMs`. Returns a stable array reference while nothing
 * changes, so `useSyncExternalStore` does not re-render needlessly.
 */
export class Linger<T> {
    readonly #seen = new Map<string, { item: T; first: number; last: number }>();
    readonly #key: (item: T) => string;
    readonly #showMs: number;
    readonly #hideMs: number;
    #out: T[] = [];
    #sig = "";

    constructor(key: (item: T) => string, showMs = 120, hideMs = 450) {
        this.#key = key;
        this.#showMs = showMs;
        this.#hideMs = hideMs;
    }

    update(items: readonly T[], now: number): T[] {
        for (const item of items) {
            const k = this.#key(item);
            const prev = this.#seen.get(k);
            this.#seen.set(k, { item, first: prev?.first ?? now, last: now });
        }
        const out: T[] = [];
        let sig = "";
        for (const [k, e] of this.#seen) {
            if (now - e.last > this.#hideMs) {
                this.#seen.delete(k);
                continue;
            }
            if (now - e.first < this.#showMs) continue;
            out.push(e.item);
            sig += `${k}|`;
        }
        // New positions for the same set still re-render (boxes must follow), but an
        // unchanged set of identical objects keeps the previous reference.
        const same = sig === this.#sig && out.every((v, i) => v === this.#out[i]);
        if (!same) {
            this.#out = out;
            this.#sig = sig;
        }
        return this.#out;
    }
}

/** External store over a FrameStore that advances a filter only when a frame arrives. */
class FilteredFrames<T> {
    value: T;
    readonly #store: FrameStore;
    readonly #step: (info: StudioFrameInfo | null, now: number, prev: T) => T;

    constructor(store: FrameStore, initial: T, step: (info: StudioFrameInfo | null, now: number, prev: T) => T) {
        this.#store = store;
        this.value = initial;
        this.#step = step;
    }

    subscribe = (cb: () => void): (() => void) =>
        this.#store.subscribe(() => {
            const next = this.#step(this.#store.get(), performance.now(), this.value);
            if (next !== this.value) {
                this.value = next;
                cb();
            }
        });

    get = (): T => this.value;
}

/**
 * `useFrame` over a list with presence hysteresis (see Linger). `select`,
 * `key` and the timings are read once, at mount; pass module-level functions.
 */
export function useLingering<T>(store: FrameStore, select: (info: StudioFrameInfo | null) => readonly T[], key: (item: T) => string, showMs?: number, hideMs?: number): T[] {
    const [source] = useState(() => {
        const linger = new Linger(key, showMs, hideMs);
        return new FilteredFrames<T[]>(store, [], (info, now) => linger.update(select(info), now));
    });
    return useSyncExternalStore(source.subscribe, source.get, source.get);
}

/** Rarely-changing studio state shared by every overlay and panel. */
export interface StudioContextValue {
    controller: StudioController;
    frames: FrameStore;
    studio: StudioSettings;
    vision: VisionSettings;
    profiles: readonly IdentityProfile[];
    petsHidden: boolean;
    /** The displayed output image inside the shell, in shell-local CSS px. */
    rect: Rect;
    /** Live value of `rect` for rAF loops (no re-render needed). */
    rectRef: { current: Rect };
    canvas: HTMLCanvasElement;
    /** Apply now (engine) and persist (debounced). */
    patchStudio(patch: Partial<StudioSettings>): void;
    patchVision(patch: Partial<VisionSettings>): void;
    /** Persist voice/audio edits; the main window (which owns playback and the mic) applies them. */
    patchSound(patch: { voice?: Partial<VoiceSettings>; audio?: Partial<AudioSettings> }): void;
}

export const StudioContext = createContext<StudioContextValue | null>(null);

/**
 * `useFrame` for a primitive that must not flap: a new value is adopted only
 * after it has held for `settleMs` (switching on) or `releaseMs` (switching
 * back to `idle`). Used for warnings, badges and meters that toggled on
 * single noisy frames.
 */
export function useSettledFrame<T extends string | number | boolean | null>(
    store: FrameStore,
    select: (info: StudioFrameInfo | null) => T,
    idle: T,
    settleMs = 300,
    releaseMs = 800,
): T {
    const [source] = useState(() => {
        let pending = idle;
        let since = 0;
        return new FilteredFrames<T>(store, idle, (info, now, value) => {
            const raw = select(info);
            if (raw === value) {
                pending = raw;
                return value;
            }
            if (raw !== pending) {
                pending = raw;
                since = now;
                return value;
            }
            return now - since >= (raw === idle ? releaseMs : settleMs) ? raw : value;
        });
    });
    return useSyncExternalStore(source.subscribe, source.get, source.get);
}

export function useStudio(): StudioContextValue {
    const ctx = useContext(StudioContext);
    if (!ctx) throw new Error("useStudio outside <StudioShell>");
    return ctx;
}

/** Shared visual language: dark glass over arbitrary video, AA text contrast on top. */
export const GLASS =
    "border border-white/15 bg-neutral-950/70 text-white shadow-[0_8px_32px_rgb(0_0_0/0.45)] backdrop-blur-xl backdrop-saturate-150";
export const FOCUS_RING =
    "outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950";
export const SPRING = { type: "spring", bounce: 0.15, visualDuration: 0.3 } as const;
export const INSTANT = { duration: 0 } as const;

/** Glyphs for signals shown in the HUD, tutorial and toasts. */
export const SIGNAL_EMOJI: Readonly<Partial<Record<string, string>>> = {
    thumb_up: "👍",
    thumb_down: "👎",
    open_palm: "✋",
    fist: "✊",
    victory: "✌️",
    i_love_you: "🤟",
    point_up: "☝️",
    ok: "👌",
    rock: "🤘",
    call_me: "🤙",
    heart: "🫶",
    frame: "🖼️",
    timeout: "⏸️",
    prayer: "🙏",
    clap: "👏",
    spread: "↔️",
    squeeze: "🤏",
    swipe_left: "👈",
    swipe_right: "👉",
    swipe_up: "👆",
    swipe_down: "👇",
    wave: "👋",
    circle: "⭕",
    wink_left: "😉",
    wink_right: "😉",
    smile: "😄",
    mouth_open: "😮",
    brows_up: "🤨",
    pucker: "😗",
    tongue_out: "😛",
    nod: "🙂",
    shake: "🙃",
    laughing: "😂",
    drinking: "🥤",
};
