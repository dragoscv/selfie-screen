import { MOMENTARY_SIGNALS, signalFamily, type SignalEvent, type SignalFamily, type SignalId, type Subject } from "@tiksee/core";

import type { Obs, Pulse, Side } from "./types.js";

/**
 * Turns per-frame observations into debounced SignalEvents.
 *
 * Level signals: score >= `on` for `minOnMs` -> `start`; score < `off` for
 * `minOffMs` -> `end` (with durationMs). A new start needs `cooldownMs` since
 * the previous end. Momentary signals emit one `pulse` instead of start/end,
 * either from `Pulse` detections or from the start edge of a level.
 * A signal not observed in a frame counts as score 0 for that subject.
 */
export interface SignalConfig {
    on: number;
    off: number;
    minOnMs: number;
    minOffMs: number;
    cooldownMs: number;
}

const FAMILY_DEFAULTS: Record<SignalFamily, SignalConfig> = {
    hand: { on: 0.5, off: 0.35, minOnMs: 150, minOffMs: 200, cooldownMs: 250 },
    twoHands: { on: 0.5, off: 0.35, minOnMs: 200, minOffMs: 250, cooldownMs: 400 },
    motion: { on: 0.5, off: 0.35, minOnMs: 0, minOffMs: 0, cooldownMs: 800 },
    face: { on: 0.5, off: 0.35, minOnMs: 200, minOffMs: 250, cooldownMs: 300 },
    posture: { on: 0.5, off: 0.35, minOnMs: 1000, minOffMs: 1000, cooldownMs: 1000 },
    state: { on: 0.5, off: 0.35, minOnMs: 1000, minOffMs: 1500, cooldownMs: 1000 },
    presence: { on: 0.5, off: 0.35, minOnMs: 0, minOffMs: 0, cooldownMs: 0 },
};

const SIGNAL_DEFAULTS: Partial<Record<SignalId, Partial<SignalConfig>>> = {
    slouch: { minOnMs: 60_000, minOffMs: 3000 },
    away: { minOnMs: 0, minOffMs: 500 },
    energy_high: { minOnMs: 3000, minOffMs: 3000, cooldownMs: 10_000 },
    energy_low: { minOnMs: 5000, minOffMs: 3000, cooldownMs: 10_000 },
    eyes_closed: { minOnMs: 0, minOffMs: 100 },
    look_away: { minOnMs: 0, minOffMs: 300 },
    wink_left: { cooldownMs: 500 },
    wink_right: { cooldownMs: 500 },
    blink_double: { cooldownMs: 800 },
    clap: { cooldownMs: 250 },
    nod: { cooldownMs: 1000 },
    shake: { cooldownMs: 1000 },
};

export function defaultSignalConfig(signal: SignalId): SignalConfig {
    return { ...FAMILY_DEFAULTS[signalFamily(signal)], ...SIGNAL_DEFAULTS[signal] };
}

/**
 * Personal gesture thresholds (settings `vision.calibration.hands.gestures`: signal -> score)
 * as tracker overrides: `on` = the calibrated score, `off` keeps the default hysteresis ratio
 * below it. Unknown signal names and non-finite scores are ignored.
 */
export function gestureOverrides(gestures: Readonly<Record<string, number>>, known: readonly string[]): Partial<Record<SignalId, Partial<SignalConfig>>> {
    const out: Partial<Record<SignalId, Partial<SignalConfig>>> = {};
    for (const [signal, score] of Object.entries(gestures)) {
        if (!known.includes(signal) || !Number.isFinite(score)) continue;
        const id = signal as SignalId;
        const d = defaultSignalConfig(id);
        const on = Math.min(Math.max(score, 0.2), 0.95);
        out[id] = { on, off: Math.min(on - 0.05, on * (d.off / d.on)) };
    }
    return out;
}

export interface TrackerOptions {
    armHoldMs: number;
    armWindowMs: number;
    /** Signal whose hold arms sensitive rules. */
    armSignal: SignalId;
    overrides: Partial<Record<SignalId, Partial<SignalConfig>>>;
}

type Phase = "off" | "pending" | "on" | "releasing";

interface State {
    signal: SignalId;
    hand: Side | undefined;
    phase: Phase;
    /** When the current phase began. */
    since: number;
    /** When `start` was emitted. */
    startedAt: number;
    lastEnd: number;
    lastPulse: number;
    conf: number;
    value: number | undefined;
    seen: boolean;
}

export interface HoldProgress {
    track: number;
    signal: SignalId;
    hand?: Side;
    /** 0..1 towards the longest hold any trigger (or the arm) needs. */
    progress: number;
    active: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SignalTracker {
    readonly #o: TrackerOptions;
    readonly #configs = new Map<SignalId, SignalConfig>();
    readonly #states = new Map<number, Map<string, State>>();
    readonly #subjects = new Map<number, Subject>();
    #holdTargets: Partial<Record<SignalId, number>> = {};
    #armedUntil = -Infinity;
    #armSince = new Map<number, number>();
    #armUsed = new Set<number>();

    constructor(options: Partial<TrackerOptions> = {}) {
        this.#o = { armHoldMs: 1000, armWindowMs: 5000, armSignal: "open_palm", overrides: {}, ...options };
    }

    setArm(holdMs: number, windowMs: number): void {
        this.#o.armHoldMs = holdMs;
        this.#o.armWindowMs = windowMs;
    }

    /** Longest `hold` duration any enabled rule waits for, per signal (drives the HUD ring). */
    setHoldTargets(targets: Partial<Record<SignalId, number>>): void {
        this.#holdTargets = targets;
    }

    /** Replace per-signal config overrides (e.g. personal gesture thresholds from calibration). */
    setOverrides(overrides: Partial<Record<SignalId, Partial<SignalConfig>>>): void {
        this.#o.overrides = overrides;
        this.#configs.clear();
    }

    config(signal: SignalId): SignalConfig {
        let c = this.#configs.get(signal);
        if (!c) {
            c = { ...defaultSignalConfig(signal), ...this.#o.overrides[signal] };
            this.#configs.set(signal, c);
        }
        return c;
    }

    isArmed(tMs: number): boolean {
        return tMs < this.#armedUntil;
    }

    disarm(): void {
        this.#armedUntil = -Infinity;
    }

    /** Process one frame of one subject. */
    update(subject: Subject, obs: readonly Obs[], pulses: readonly Pulse[], tMs: number): SignalEvent[] {
        this.#subjects.set(subject.track, subject);
        const states = this.#statesOf(subject.track);
        const events: SignalEvent[] = [];
        for (const s of states.values()) s.seen = false;

        // Merge duplicates (e.g. two sources for one signal): keep the max score.
        const frame = new Map<string, Obs>();
        for (const o of obs) {
            const k = key(o.signal, o.hand);
            const prev = frame.get(k);
            if (!prev || o.score > prev.score) frame.set(k, o);
        }
        for (const [k, o] of frame) {
            let s = states.get(k);
            if (!s) {
                s = { signal: o.signal, hand: o.hand, phase: "off", since: tMs, startedAt: 0, lastEnd: -Infinity, lastPulse: -Infinity, conf: 0, value: undefined, seen: false };
                states.set(k, s);
            }
            s.seen = true;
            this.#step(s, o.score, o.value, subject, tMs, events);
        }
        for (const s of states.values()) if (!s.seen) this.#step(s, 0, undefined, subject, tMs, events);

        for (const p of pulses) {
            const k = key(p.signal, p.hand);
            let s = states.get(k);
            if (!s) {
                s = { signal: p.signal, hand: p.hand, phase: "off", since: tMs, startedAt: 0, lastEnd: -Infinity, lastPulse: -Infinity, conf: 0, value: undefined, seen: true };
                states.set(k, s);
            }
            if (tMs - s.lastPulse < this.config(p.signal).cooldownMs) continue;
            s.lastPulse = tMs;
            events.push(event(p.signal, "pulse", tMs, p.confidence, subject, p.hand, p.value));
        }

        this.#updateArm(subject, frame, tMs);
        return events;
    }

    /** The subject left: end every active state (no pulses). */
    leave(track: number, tMs: number): SignalEvent[] {
        const states = this.#states.get(track);
        const subject = this.#subjects.get(track);
        const events: SignalEvent[] = [];
        if (states && subject) {
            for (const s of states.values()) {
                if ((s.phase === "on" || s.phase === "releasing") && !MOMENTARY_SIGNALS.has(s.signal)) {
                    const end = s.phase === "releasing" ? s.since : tMs;
                    events.push({ ...event(s.signal, "end", tMs, s.conf, subject, s.hand, s.value), durationMs: Math.max(0, Math.round(end - s.startedAt)) });
                }
            }
        }
        this.#states.delete(track);
        this.#subjects.delete(track);
        this.#armSince.delete(track);
        this.#armUsed.delete(track);
        return events;
    }

    /** Signals currently on for a track (level signals only). */
    active(track: number): SignalId[] {
        const states = this.#states.get(track);
        if (!states) return [];
        const out = new Set<SignalId>();
        for (const s of states.values()) if (s.phase === "on" || s.phase === "releasing") out.add(s.signal);
        return [...out];
    }

    /** Hold progress for pending/active level signals, for the HUD. */
    holds(tMs: number, families?: ReadonlySet<SignalFamily>): HoldProgress[] {
        const out: HoldProgress[] = [];
        for (const [track, states] of this.#states) {
            for (const s of states.values()) {
                if (s.phase === "off" || MOMENTARY_SIGNALS.has(s.signal)) continue;
                if (families && !families.has(signalFamily(s.signal))) continue;
                const c = this.config(s.signal);
                const target = Math.max(
                    c.minOnMs,
                    this.#holdTargets[s.signal] ?? 0,
                    s.signal === this.#o.armSignal && this.#subjects.get(track)?.owner ? this.#o.armHoldMs : 0,
                );
                const began = s.phase === "pending" ? s.since : s.startedAt - c.minOnMs;
                const progress = target > 0 ? clamp01((tMs - began) / target) : 1;
                out.push({ track, signal: s.signal, ...(s.hand ? { hand: s.hand } : {}), progress, active: s.phase !== "pending" });
            }
        }
        return out;
    }

    #statesOf(track: number): Map<string, State> {
        let m = this.#states.get(track);
        if (!m) {
            m = new Map();
            this.#states.set(track, m);
        }
        return m;
    }

    #step(s: State, score: number, value: number | undefined, subject: Subject, tMs: number, events: SignalEvent[]): void {
        const c = this.config(s.signal);
        const momentary = MOMENTARY_SIGNALS.has(s.signal);
        switch (s.phase) {
            case "off":
                if (score >= c.on && tMs - s.lastEnd >= c.cooldownMs) {
                    s.phase = "pending";
                    s.since = tMs;
                    s.conf = score;
                    if (c.minOnMs === 0) this.#step(s, score, value, subject, tMs, events);
                }
                return;
            case "pending":
                if (score < c.off) {
                    s.phase = "off";
                    return;
                }
                s.conf = Math.max(s.conf, score);
                if (tMs - s.since >= c.minOnMs) {
                    s.phase = "on";
                    s.startedAt = tMs;
                    s.value = value;
                    if (momentary) {
                        if (tMs - s.lastPulse >= c.cooldownMs) {
                            s.lastPulse = tMs;
                            events.push(event(s.signal, "pulse", tMs, s.conf, subject, s.hand, value));
                        }
                    } else events.push(event(s.signal, "start", tMs, s.conf, subject, s.hand, value));
                }
                return;
            case "on":
                if (score < c.off) {
                    s.phase = "releasing";
                    s.since = tMs;
                    if (c.minOffMs === 0) this.#step(s, score, value, subject, tMs, events);
                } else {
                    s.conf = Math.max(s.conf, score);
                    if (value !== undefined) s.value = value;
                }
                return;
            case "releasing":
                // Back inside the hysteresis band (>= off) cancels the release.
                if (score >= c.off) {
                    s.phase = "on";
                    return;
                }
                if (tMs - s.since >= c.minOffMs) {
                    s.phase = "off";
                    s.lastEnd = tMs;
                    if (!momentary) {
                        events.push({
                            ...event(s.signal, "end", tMs, s.conf, subject, s.hand, s.value),
                            durationMs: Math.max(0, Math.round(s.since - s.startedAt)),
                        });
                    }
                    s.conf = 0;
                }
                return;
        }
    }

    #updateArm(subject: Subject, frame: Map<string, Obs>, tMs: number): void {
        if (!subject.owner) return;
        const c = this.config(this.#o.armSignal);
        let palm = false;
        for (const o of frame.values()) if (o.signal === this.#o.armSignal && o.score >= c.on) palm = true;
        if (!palm) {
            this.#armSince.delete(subject.track);
            this.#armUsed.delete(subject.track);
            return;
        }
        const since = this.#armSince.get(subject.track) ?? tMs;
        this.#armSince.set(subject.track, since);
        if (!this.#armUsed.has(subject.track) && tMs - since >= this.#o.armHoldMs) {
            this.#armUsed.add(subject.track);
            this.#armedUntil = tMs + this.#o.armWindowMs;
        }
    }
}

function key(signal: SignalId, hand: Side | undefined): string {
    return hand ? `${signal}|${hand}` : signal;
}

function event(
    signal: SignalId,
    phase: SignalEvent["phase"],
    at: number,
    confidence: number,
    subject: Subject,
    hand: Side | undefined,
    value: number | undefined,
): SignalEvent {
    return {
        signal,
        phase,
        at: Math.round(at),
        confidence: clamp01(confidence),
        subject: { ...subject },
        ...(hand ? { hand } : {}),
        ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
    };
}
