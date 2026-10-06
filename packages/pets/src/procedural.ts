/**
 * The "alive" layer for pets: saccadic gaze, breathing, spring follow-through
 * (tails, ears), squash & stretch and idle micro-motion. Pure math, no three.js,
 * no per-frame allocation; PetActor maps the outputs onto bones.
 */

const DEG = Math.PI / 180;

/** Max deflection of a spring bone from its clip pose (radians). */
export const SPRING_CLAMP = 35 * DEG;
/** A gaze shift above this triggers a blink. */
export const BLINK_SHIFT = 20 * DEG;
/** Gaze differences up to this are corrected by micro-saccades instead of a main jump. */
const MICRO_MAX = 3.5 * DEG;
/** A target this far away interrupts the hold (reflexive look). */
const REFLEX_SHIFT = 0.5;
const REFLEX_MIN_HOLD_S = 0.15;

/** Minimum-jerk ease 0..1 (saccade velocity profile). */
export function minJerk(u: number): number {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    return u * u * u * (10 - 15 * u + 6 * u * u);
}

/** Saccade duration: 80 ms for tiny jumps up to 120 ms for large ones. */
export function saccadeDuration(amplitude: number): number {
    return 0.08 + 0.04 * Math.min(Math.abs(amplitude) / 0.5, 1);
}

/**
 * Gaze that holds a target 0.4-2 s and then jumps (minimum-jerk, 80-120 ms),
 * with 1-3° micro-saccades during the hold. Never slides continuously.
 */
export class Saccade {
    /** Current gaze (radians). */
    yaw = 0;
    pitch = 0;
    readonly #rand: () => number;
    #baseYaw = 0;
    #basePitch = 0;
    #fromYaw = 0;
    #fromPitch = 0;
    #toYaw = 0;
    #toPitch = 0;
    #jumpT = -1;
    #jumpDur = 0.1;
    #holdLeft: number;
    #microLeft: number;
    #heldFor = 0;

    constructor(rand: () => number) {
        this.#rand = rand;
        this.#holdLeft = this.#hold(0.3);
        this.#microLeft = this.#micro();
    }

    /** True while a jump is in flight. */
    get moving(): boolean {
        return this.#jumpT >= 0;
    }

    #hold(arousal: number): number {
        return Math.max(0.4, (0.4 + this.#rand() * 1.6) * (1 - 0.4 * arousal));
    }

    #micro(): number {
        return 0.3 + this.#rand() * 0.6;
    }

    #jumpTo(yaw: number, pitch: number): void {
        this.#fromYaw = this.yaw;
        this.#fromPitch = this.pitch;
        this.#toYaw = yaw;
        this.#toPitch = pitch;
        this.#jumpDur = saccadeDuration(Math.hypot(yaw - this.yaw, pitch - this.pitch));
        this.#jumpT = 0;
    }

    /** Advance; returns the size (radians) of a main gaze shift started this frame, else 0. */
    step(dt: number, wantYaw: number, wantPitch: number, arousal: number): number {
        this.#heldFor += dt;
        this.#holdLeft -= dt;
        this.#microLeft -= dt;
        const dist = Math.hypot(wantYaw - this.#baseYaw, wantPitch - this.#basePitch);
        let major = 0;
        const expired = this.#holdLeft <= 0;
        if ((expired && dist > MICRO_MAX) || (dist > REFLEX_SHIFT && this.#heldFor >= REFLEX_MIN_HOLD_S)) {
            major = Math.hypot(wantYaw - this.yaw, wantPitch - this.pitch);
            this.#baseYaw = wantYaw;
            this.#basePitch = wantPitch;
            this.#heldFor = 0;
            this.#holdLeft = this.#hold(arousal);
            this.#microLeft = this.#micro();
            this.#jumpTo(wantYaw, wantPitch);
        } else {
            if (expired) {
                // Target barely moved: keep holding; the next micro-saccade re-centres on it.
                this.#baseYaw = wantYaw;
                this.#basePitch = wantPitch;
                this.#holdLeft = this.#hold(arousal);
            }
            if (this.#microLeft <= 0 && this.#jumpT < 0) {
                // Micro-saccade: the held target plus a 1-3° offset.
                this.#microLeft = this.#micro();
                const a = this.#rand() * Math.PI * 2;
                const m = (1 + 2 * this.#rand()) * DEG;
                this.#jumpTo(this.#baseYaw + Math.cos(a) * m, this.#basePitch + Math.sin(a) * m * 0.6);
            }
        }
        if (this.#jumpT >= 0) {
            this.#jumpT += dt;
            const s = minJerk(this.#jumpT / this.#jumpDur);
            this.yaw = this.#fromYaw + (this.#toYaw - this.#fromYaw) * s;
            this.pitch = this.#fromPitch + (this.#toPitch - this.#fromPitch) * s;
            if (this.#jumpT >= this.#jumpDur) this.#jumpT = -1;
        }
        return major;
    }
}

/** Breathing rate (Hz): 0.25 calm .. 0.35 excited. */
export function breathFrequency(arousal: number): number {
    return 0.25 + 0.1 * clamp01(arousal);
}

/** Breathing amplitude (radians of chest pitch). */
export function breathAmplitude(arousal: number): number {
    return 0.015 + 0.035 * clamp01(arousal);
}

/** Phase-continuous breathing oscillator (rate changes never jump the chest). */
export class Breath {
    #phase: number;
    value = 0;

    constructor(phase = 0) {
        this.#phase = phase;
    }

    step(dt: number, arousal: number): number {
        this.#phase = (this.#phase + 2 * Math.PI * breathFrequency(arousal) * dt) % (2 * Math.PI);
        // Inhale slightly faster than exhale.
        const s = Math.sin(this.#phase);
        // max |sin φ + 0.15·sin 2φ| ≈ 1.0414.
        this.value = (breathAmplitude(arousal) * (s + 0.15 * Math.sin(2 * this.#phase))) / 1.0414;
        return this.value;
    }
}

/**
 * Damped angular spring on a rotation vector (radians, any frame). Pulled
 * toward a target, magnitude clamped; outward velocity is killed at the clamp.
 */
export class AngularSpring {
    x = 0;
    y = 0;
    z = 0;
    #vx = 0;
    #vy = 0;
    #vz = 0;
    readonly omega: number;
    readonly zeta: number;
    readonly clamp: number;

    constructor(omega: number, zeta: number, clamp = SPRING_CLAMP) {
        this.omega = omega;
        this.zeta = zeta;
        this.clamp = clamp;
    }

    get magnitude(): number {
        return Math.hypot(this.x, this.y, this.z);
    }

    impulse(vx: number, vy: number, vz: number): void {
        this.#vx += vx;
        this.#vy += vy;
        this.#vz += vz;
    }

    step(dt: number, tx: number, ty: number, tz: number): void {
        if (!(dt > 0)) return;
        const t = Math.min(dt, 0.1);
        const n = Math.max(1, Math.ceil((t * this.omega) / 0.3));
        const h = t / n;
        const k = this.omega * this.omega;
        const c = 2 * this.zeta * this.omega;
        for (let i = 0; i < n; i++) {
            // Semi-implicit Euler: stable for omega*h <= 0.3.
            this.#vx += (k * (tx - this.x) - c * this.#vx) * h;
            this.#vy += (k * (ty - this.y) - c * this.#vy) * h;
            this.#vz += (k * (tz - this.z) - c * this.#vz) * h;
            this.x += this.#vx * h;
            this.y += this.#vy * h;
            this.z += this.#vz * h;
            const m = Math.hypot(this.x, this.y, this.z);
            if (m > this.clamp) {
                const s = this.clamp / m;
                this.x *= s;
                this.y *= s;
                this.z *= s;
                const nx = this.x / this.clamp;
                const ny = this.y / this.clamp;
                const nz = this.z / this.clamp;
                const vr = this.#vx * nx + this.#vy * ny + this.#vz * nz;
                if (vr > 0) {
                    this.#vx -= vr * nx;
                    this.#vy -= vr * ny;
                    this.#vz -= vr * nz;
                }
            }
        }
    }
}

/**
 * Inertial lag of a bone pointing along `d` (unit, root frame) when its base
 * accelerates by `a` (m/s², root frame) and yaws at `yawRate` (rad/s):
 * rotation vector `gain·(a × d) − yawGain·yawRate·Ŷ` (the tip trails).
 * Written into `out` (no allocation).
 */
export function inertialTarget(
    d: readonly [number, number, number],
    ax: number,
    ay: number,
    az: number,
    yawRate: number,
    gain: number,
    yawGain: number,
    out: [number, number, number],
): void {
    out[0] = gain * (ay * d[2] - az * d[1]);
    out[1] = gain * (az * d[0] - ax * d[2]) - yawGain * yawRate;
    out[2] = gain * (ax * d[1] - ay * d[0]);
}

/** Squash envelope 0..1 over normalised time: quick rise (30 %), smooth release. */
export function squashEnvelope(u: number): number {
    if (u <= 0 || u >= 1) return 0;
    if (u < 0.3) return Math.sin((u / 0.3) * (Math.PI / 2));
    return 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.3)) / 0.7);
}

/** Volume-preserving squash: y shrinks by `amount·env`, x and z grow so x·y·z = 1. */
export function squashScale(env: number, amount: number): { y: number; xz: number } {
    const y = 1 - amount * env;
    return { y, xz: 1 / Math.sqrt(y) };
}

/** Timed squash (landing / hop anticipation). `y` is the current vertical factor. */
export class Squash {
    #t = -1;
    #dur = 0.12;
    #amount = 0;
    y = 1;
    xz = 1;

    start(amount: number, durS: number): void {
        this.#t = 0;
        this.#dur = durS;
        this.#amount = amount;
    }

    get active(): boolean {
        return this.#t >= 0;
    }

    step(dt: number): void {
        if (this.#t < 0) {
            this.y = 1;
            this.xz = 1;
            return;
        }
        this.#t += dt;
        const u = this.#t / this.#dur;
        if (u >= 1) this.#t = -1;
        const env = squashEnvelope(u);
        this.y = 1 - this.#amount * env;
        this.xz = 1 / Math.sqrt(this.y);
    }
}

/** Stretch along travel while flying: 1 below 0.5 m/s, up to `max` at 1.4 m/s. */
export function stretchFactor(speed: number, max = 1.08): number {
    const u = clamp01((speed - 0.5) / 0.9);
    return 1 + (max - 1) * u * u * (3 - 2 * u);
}

export type IdleEvent = "tilt" | "earL" | "earR" | null;

/** Small head tilts and ear flicks every 3-8 s (seeded). `tilt` = head roll (radians). */
export class IdleTwitch {
    readonly #rand: () => number;
    #next: number;
    #tiltStart = -1;
    #tiltDur = 1;
    #tiltAmp = 0;
    tilt = 0;

    constructor(rand: () => number, tSec: number) {
        this.#rand = rand;
        this.#next = tSec + 3 + 5 * rand();
    }

    step(tSec: number): IdleEvent {
        let ev: IdleEvent = null;
        if (tSec >= this.#next) {
            this.#next = tSec + 3 + 5 * this.#rand();
            const r = this.#rand();
            if (r < 0.5) {
                ev = "tilt";
                this.#tiltStart = tSec;
                this.#tiltDur = 0.6 + this.#rand() * 0.9;
                this.#tiltAmp = (this.#rand() < 0.5 ? -1 : 1) * (4 + 4 * this.#rand()) * DEG;
            } else ev = r < 0.75 ? "earL" : "earR";
        }
        if (this.#tiltStart >= 0) {
            const t = tSec - this.#tiltStart;
            const ramp = 0.25;
            const total = this.#tiltDur + 2 * ramp;
            if (t >= total) {
                this.#tiltStart = -1;
                this.tilt = 0;
            } else {
                const env = t < ramp ? minJerk(t / ramp) : t > total - ramp ? minJerk((total - t) / ramp) : 1;
                this.tilt = this.#tiltAmp * env;
            }
        }
        return ev;
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
