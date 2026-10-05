/**
 * Pet behaviour, independent of rendering. Clip names match the actions baked
 * by assets/pets/blender/anims.py. Pure and clock-injected so it is testable.
 */
export const PET_CLIPS = ["idle", "look", "talk", "react", "dance", "sleep", "fly"] as const;
export type PetClip = (typeof PET_CLIPS)[number];

export type PetEvent =
    | { type: "speechStart" }
    | { type: "speechEnd" }
    | { type: "gift"; tier: "small" | "big" }
    | { type: "chat" }
    | { type: "command"; clip: PetClip };

export interface PetBehaviour {
    /** Quiet time before the pet falls asleep (Q41). */
    sleepAfterMs: number;
    /** Mean gap between idle glances. */
    lookEveryMs: number;
}

export const DEFAULT_BEHAVIOUR: PetBehaviour = { sleepAfterMs: 120_000, lookEveryMs: 9_000 };

/** One-shot clips play once then fall back; looping clips hold until changed. */
const ONE_SHOT: Readonly<Record<PetClip, number>> = {
    idle: 0,
    look: 3000,
    talk: 0,
    react: 1200,
    dance: 4800,
    sleep: 0,
    fly: 2000,
};

export class PetStateMachine {
    readonly #b: PetBehaviour;
    readonly #rand: () => number;
    #clip: PetClip = "idle";
    #until = 0;
    #talking = false;
    #lastActivity: number;
    #nextLook: number;

    constructor(nowMs: number, behaviour: PetBehaviour = DEFAULT_BEHAVIOUR, rand: () => number = Math.random) {
        this.#b = behaviour;
        this.#rand = rand;
        this.#lastActivity = nowMs;
        this.#nextLook = nowMs + this.#lookGap();
    }

    get clip(): PetClip {
        return this.#clip;
    }

    get talking(): boolean {
        return this.#talking;
    }

    #lookGap(): number {
        return this.#b.lookEveryMs * (0.5 + this.#rand());
    }

    #play(clip: PetClip, now: number): void {
        this.#clip = clip;
        const len = ONE_SHOT[clip];
        this.#until = len > 0 ? now + len : 0;
    }

    send(event: PetEvent, now: number): void {
        this.#lastActivity = now;
        switch (event.type) {
            case "speechStart":
                this.#talking = true;
                if (!this.#until) this.#play("talk", now);
                break;
            case "speechEnd":
                this.#talking = false;
                if (this.#clip === "talk") this.#play("idle", now);
                break;
            case "gift":
                this.#play(event.tier === "big" ? "dance" : "react", now);
                break;
            case "chat":
                if (this.#clip === "sleep") this.#play("react", now);
                break;
            case "command":
                this.#play(event.clip, now);
                break;
        }
    }

    /** Advance time; returns the clip that should be playing now. */
    tick(now: number): PetClip {
        if (this.#until && now >= this.#until) {
            this.#play(this.#talking ? "talk" : "idle", now);
        }
        if (this.#until) return this.#clip;
        if (!this.#talking && now - this.#lastActivity >= this.#b.sleepAfterMs) {
            if (this.#clip !== "sleep") this.#play("sleep", now);
            return this.#clip;
        }
        if (this.#clip === "idle" && now >= this.#nextLook) {
            this.#play("look", now);
            this.#nextLook = now + ONE_SHOT.look + this.#lookGap();
        }
        return this.#clip;
    }
}
