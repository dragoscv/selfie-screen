/**
 * Index-finger dial: point with the index finger only and draw circles with its tip, like
 * turning a knob. Clockwise (as you see it in the preview) = zoom in, counter-clockwise =
 * zoom out; one full turn = DIAL_ZOOM_PER_TURN. Gives the ZoomDriver a log offset.
 */

export interface DialHand {
    side: "left" | "right";
    /** Classified shape (gesture id) or null. */
    shape: string | null;
    /** 21 landmarks in preview pixels (x right, y down), so circles are round. */
    lm: readonly { x: number; y: number }[];
}

export interface DialState {
    active: boolean;
    /** Log zoom offset since the dial started. */
    wish: number;
    /** The dial ended this frame. */
    ended: boolean;
}

/** Zoom factor per full clockwise turn. */
export const DIAL_ZOOM_PER_TURN = 1.6;
/** Turning this much in one direction (rad) within START_WINDOW_MS starts the dial. */
export const DIAL_START_RAD = (2 * Math.PI) / 3;
const START_WINDOW_MS = 900;
/** Tip positions kept to find the circle's centre. */
const CENTRE_WINDOW_MS = 700;
/** The tip must circle at least this far from the centre (palm widths) to count. */
const MIN_RADIUS_PALM = 0.18;
/** Stops pointing this long -> the dial ends. */
const LOST_MS = 350;
/** No turning this long -> the dial ends. */
const STILL_MS = 1200;

const POINTING = new Set(["point_up", "point_left", "point_right", "fingers_1"]);
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Track {
    tips: { t: number; x: number; y: number }[];
    lastAngle: number | null;
    /** Recent signed angle steps, for the start check. */
    steps: { t: number; d: number }[];
    lastPoint: number;
    lastTurn: number;
}

const freshTrack = (): Track => ({ tips: [], lastAngle: null, steps: [], lastPoint: -Infinity, lastTurn: -Infinity });

export class IndexDial {
    readonly #tracks: Record<"left" | "right", Track> = { left: freshTrack(), right: freshTrack() };
    #active: "left" | "right" | null = null;
    #acc = 0;

    get active(): boolean {
        return this.#active !== null;
    }

    /**
     * `hands` = a FRESH hand result (null when there is no new one this frame: only the
     * timeouts run). `blocked(side)` = that hand may not start a dial (safe zone, pinch zoom).
     */
    update(nowMs: number, hands: readonly DialHand[] | null, blocked: (side: "left" | "right") => boolean): DialState {
        if (hands) for (const h of hands) this.#feed(nowMs, h);
        const side = this.#active;
        if (side) {
            const tr = this.#tracks[side];
            if (nowMs - tr.lastPoint > LOST_MS || nowMs - tr.lastTurn > STILL_MS) {
                this.#active = null;
                return { active: false, wish: this.#wish(), ended: true };
            }
            return { active: true, wish: this.#wish(), ended: false };
        }
        for (const s of ["right", "left"] as const) {
            const tr = this.#tracks[s];
            const sum = tr.steps.filter((x) => nowMs - x.t <= START_WINDOW_MS).reduce((a, x) => a + x.d, 0);
            if (Math.abs(sum) >= DIAL_START_RAD && !blocked(s) && nowMs - tr.lastPoint < LOST_MS) {
                this.#active = s;
                // The turn that started it counts, so the zoom begins right away.
                this.#acc = sum;
                return { active: true, wish: this.#wish(), ended: false };
            }
        }
        return { active: false, wish: 0, ended: false };
    }

    #wish(): number {
        return (this.#acc / (2 * Math.PI)) * Math.log(DIAL_ZOOM_PER_TURN);
    }

    #feed(t: number, h: DialHand): void {
        const tr = this.#tracks[h.side];
        const tip = h.lm[INDEX_TIP];
        const w = h.lm[WRIST];
        const m = h.lm[MIDDLE_MCP];
        if (!h.shape || !POINTING.has(h.shape) || !tip || !w || !m) {
            // Not pointing: forget the circle so a new one starts clean.
            tr.tips = [];
            tr.lastAngle = null;
            tr.steps = [];
            return;
        }
        tr.lastPoint = t;
        tr.tips.push({ t, x: tip.x, y: tip.y });
        while (tr.tips.length > 0 && t - (tr.tips[0]?.t ?? t) > CENTRE_WINDOW_MS) tr.tips.shift();
        tr.steps = tr.steps.filter((x) => t - x.t <= START_WINDOW_MS);
        if (tr.tips.length < 4) return;
        let cx = 0;
        let cy = 0;
        for (const p of tr.tips) {
            cx += p.x;
            cy += p.y;
        }
        cx /= tr.tips.length;
        cy /= tr.tips.length;
        const palm = Math.max(Math.hypot(m.x - w.x, m.y - w.y), 1e-6);
        const r = Math.hypot(tip.x - cx, tip.y - cy);
        if (r < MIN_RADIUS_PALM * palm) {
            tr.lastAngle = null;
            return;
        }
        // y down: atan2 growing = clockwise on screen = zoom in.
        const a = Math.atan2(tip.y - cy, tip.x - cx);
        if (tr.lastAngle !== null) {
            const d = wrap(a - tr.lastAngle);
            // A jump this big between samples is a tracking glitch, not a turn.
            if (Math.abs(d) < Math.PI / 2) {
                tr.steps.push({ t, d });
                if (Math.abs(d) > 0.02) tr.lastTurn = t;
                if (this.#active === h.side) this.#acc += d;
            }
        }
        tr.lastAngle = a;
    }

    reset(): void {
        this.#active = null;
        this.#acc = 0;
        this.#tracks.left = freshTrack();
        this.#tracks.right = freshTrack();
    }
}
