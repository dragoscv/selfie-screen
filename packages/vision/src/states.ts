import { boxCentre, countReversals, dist, stddev, type Box, type Pt } from "./geometry.js";
import type { Obs } from "./types.js";

/**
 * Activity states for one person. Everything is display pixels (see
 * geometry.ts). Objects come from the ~5 Hz object detector and are reused
 * between its runs by the caller.
 */
export interface StateObject {
    label: string;
    box: Box;
    score: number;
}

export interface StateInput {
    /** jawOpen blendshape, or null when the face is not visible. */
    jawOpen: number | null;
    /** Mean smile 0..1, or null when the face is not visible. */
    smile: number | null;
    /** Mouth centre and face width (px). */
    mouth: Pt | null;
    faceW: number;
    /** Wrists / hand centres in px. */
    hands: readonly Pt[];
    objects: readonly StateObject[];
    /** Normalised (0..1 frame) movement since the previous frame: body + hands. */
    motion: number;
    /** Head rotation speed, deg/s. */
    headSpeed: number;
}

export interface StateOptions {
    talkWindowMs: number;
    talkStd: number;
    laughSmile: number;
    energyAlpha: number;
    energyHigh: number;
    energyLow: number;
}

export const DEFAULT_STATES: StateOptions = {
    talkWindowMs: 1000,
    talkStd: 0.06,
    laughSmile: 0.6,
    energyAlpha: 0.03,
    energyHigh: 0.7,
    energyLow: 0.2,
};

const DRINKS = new Set(["cup", "bottle", "wine glass"]);

export class StateAnalyzer {
    readonly #o: StateOptions;
    #jaw: { t: number; v: number }[] = [];
    #energy = 0.4;
    #eatingSince: number | null = null;

    constructor(options: Partial<StateOptions> = {}) {
        this.#o = { ...DEFAULT_STATES, ...options };
    }

    get energy(): number {
        return this.#energy;
    }

    update(s: StateInput, tMs: number): Obs[] {
        const o = this.#o;
        const out: Obs[] = [];

        if (s.jawOpen === null) this.#jaw = [];
        else {
            this.#jaw.push({ t: tMs, v: s.jawOpen });
            while (this.#jaw.length > 0 && tMs - (this.#jaw[0]?.t ?? tMs) > o.talkWindowMs) this.#jaw.shift();
        }
        const jaws = this.#jaw.map((j) => j.v);
        const enough = this.#jaw.length >= 6 && tMs - (this.#jaw[0]?.t ?? tMs) >= o.talkWindowMs * 0.6;
        const sd = enough ? stddev(jaws) : 0;
        const reversals = enough ? countReversals(jaws, 0.08) : 0;
        const laughing = enough && (s.smile ?? 0) > o.laughSmile && reversals >= 3;
        if (laughing) out.push({ signal: "laughing", score: 0.75 });
        else if (sd > o.talkStd) out.push({ signal: "talking", score: Math.min(1, 0.5 + (sd - o.talkStd) * 4), value: sd });

        // Drinking: a drink box near the mouth with a hand next to it.
        const nearMouth = (b: Box) => s.mouth !== null && dist(boxCentre(b), s.mouth) < Math.max(s.faceW, 1) * 1.1;
        const handNear = (b: Box) => s.hands.some((h) => h.x > b.x - b.w && h.x < b.x + 2 * b.w && h.y > b.y - b.h && h.y < b.y + 2 * b.h);
        const drink = s.objects.find((ob) => DRINKS.has(ob.label) && nearMouth(ob.box) && handNear(ob.box));
        if (drink) out.push({ signal: "drinking", score: Math.min(1, 0.4 + drink.score * 0.6) });

        // Eating (experimental): a hand at the mouth (no drink) while the jaw keeps moving, for 2 s.
        const handAtMouth = s.mouth !== null && s.hands.some((h) => dist(h, s.mouth as Pt) < s.faceW * 0.6);
        if (!drink && handAtMouth && sd > o.talkStd * 0.5) {
            this.#eatingSince ??= tMs;
            if (tMs - this.#eatingSince > 2000) out.push({ signal: "eating", score: 0.6 });
        } else this.#eatingSince = null;

        // Phone: a cell phone box overlapping (or touching) a hand.
        const phone = s.objects.find((ob) => ob.label === "cell phone" && handNear(ob.box));
        if (phone) out.push({ signal: "phone", score: Math.min(1, 0.4 + phone.score * 0.6) });

        // Energy: EMA of smile + body motion + head movement.
        const inst = Math.min(1, 0.4 * (s.smile ?? 0) + 0.4 * Math.min(1, s.motion * 25) + 0.2 * Math.min(1, s.headSpeed / 60));
        this.#energy += o.energyAlpha * (inst - this.#energy);
        if (this.#energy > o.energyHigh) out.push({ signal: "energy_high", score: 0.8, value: this.#energy });
        if (this.#energy < o.energyLow) out.push({ signal: "energy_low", score: 0.8, value: this.#energy });
        return out;
    }
}
