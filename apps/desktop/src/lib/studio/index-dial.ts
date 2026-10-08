/**
 * Index-finger dial: point with the index finger only and draw circles with its tip, like
 * turning a knob. Clockwise FROM YOUR OWN VIEW (as if drawing on glass in front of you) =
 * zoom in, counter-clockwise = zoom out, whatever the preview mirroring; one full turn =
 * DIAL_ZOOM_PER_TURN. Gives the ZoomDriver a log offset.
 */

export interface DialHand {
    side: "left" | "right";
    /** Classified shape (gesture id) or null. */
    shape: string | null;
    /** 21 landmarks in RAW camera pixels (x right, y down, never mirrored), so circles are round. */
    lm: readonly { x: number; y: number }[];
    /** 21 hand world landmarks (metres): finger straightness that survives motion blur and rotation. */
    world: readonly { x: number; y: number; z: number }[];
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
export const DIAL_START_RAD = Math.PI * 0.42;
/** Share of the turning steps in the window that must go the same way (no back-and-forth jitter). */
const START_CONSISTENCY = 0.7;
const START_WINDOW_MS = 1600;
/** Tip positions kept to find the circle's centre. */
const CENTRE_WINDOW_MS = 1200;
/** The tip must circle at least this far from the centre (palm widths) to count. */
const MIN_RADIUS_PALM = 0.12;
/** Stops pointing this long -> the dial ends. */
const LOST_MS = 900;
/** No turning this long -> the dial ends. */
const STILL_MS = 1500;
/**
 * Hand results arrive at ~5-15 Hz while the vision pipeline is busy: one circle can be only 6
 * samples, so a step up to 120 degrees between two samples is still a turn.
 */
const MAX_STEP_RAD = (2 * Math.PI) / 3;
/** Index straight (3D chord / bone length) and clearly straighter than the other fingers. */
const INDEX_STRAIGHT = 0.78;
const INDEX_MARGIN = 0.1;

const POINTING = new Set(["point_up", "point_left", "point_right", "fingers_1"]);
const INDEX_TIP = 8;
const WRIST = 0;
const MIDDLE_MCP = 9;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Centre of the circle through the tip trail: Kåsa least-squares fit (exact on a partial arc,
 * where the plain mean sits inside the arc and under-reads the turn), falling back to the mean
 * when the points are nearly collinear or the fit is implausibly large.
 */
export function circleCentre(pts: readonly { x: number; y: number }[], maxR: number): { x: number; y: number } {
    const n = pts.length;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
        mx += p.x;
        my += p.y;
    }
    mx /= n;
    my /= n;
    // Centred coordinates keep the 2x2 system well conditioned.
    let suu = 0;
    let svv = 0;
    let suv = 0;
    let suuu = 0;
    let svvv = 0;
    let suvv = 0;
    let svuu = 0;
    for (const p of pts) {
        const u = p.x - mx;
        const v = p.y - my;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (n < 3 || det <= 1e-9 * (suu + svv) * (suu + svv)) return { x: mx, y: my };
    const r1 = (suuu + suvv) / 2;
    const r2 = (svvv + svuu) / 2;
    const uc = (r1 * svv - r2 * suv) / det;
    const vc = (r2 * suu - r1 * suv) / det;
    if (Math.hypot(uc, vc) > maxR) return { x: mx, y: my };
    return { x: mx + uc, y: my + vc };
}

interface Track {
    tips: { t: number; x: number; y: number }[];
    lastAngle: number | null;
    /** Recent signed angle steps, for the start check. */
    steps: { t: number; d: number }[];
    lastPoint: number;
    lastTurn: number;
    /** Dev trace only. */
    dbgR: number;
    dbgShape: string;
    dbgSt: string;
    dbgFed: number;
}

const freshTrack = (): Track => ({ tips: [], lastAngle: null, steps: [], lastPoint: -Infinity, lastTurn: -Infinity, dbgR: 0, dbgShape: "-", dbgSt: "-", dbgFed: 0 });

/** MCP, PIP, DIP, TIP landmark ids for index, middle, ring, pinky. */
const FINGERS: readonly (readonly [number, number, number, number])[] = [
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
];

type P3 = { x: number; y: number; z: number };
const d3 = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Per-finger straightness from the 3D world landmarks: MCP->TIP chord / sum of the three
 * bone lengths (index, middle, ring, pinky). 1 = straight, ~0.5 = curled. Scale and rotation
 * free; the 2D ratio swung 0.1..8 while the hand circled (measured live 2026-10-08).
 */
export function fingerStraightness(world: readonly P3[]): number[] {
    return FINGERS.map(([m, p, d, t]) => {
        const a = world[m];
        const b = world[p];
        const c = world[d];
        const e = world[t];
        if (!a || !b || !c || !e) return 0;
        return d3(a, e) / Math.max(d3(a, b) + d3(b, c) + d3(c, e), 1e-6);
    });
}

/**
 * Pointing with the index finger, from 3D geometry: the classifier labels a circling hand
 * victory / fist / ok most of the time (measured live 2026-10-08: 2 point_up of 180 labels).
 */
export function isIndexPointing(world: readonly P3[], shape: string | null): boolean {
    if (shape && POINTING.has(shape)) return true;
    if (world.length < 21) return false;
    const [index = 0, middle = 0, ring = 0, pinky = 0] = fingerStraightness(world);
    return index >= INDEX_STRAIGHT && index - Math.max(middle, ring, pinky) >= INDEX_MARGIN;
}

export class IndexDial {
    readonly #tracks: Record<"left" | "right", Track> = { left: freshTrack(), right: freshTrack() };
    #active: "left" | "right" | null = null;
    #acc = 0;

    get active(): boolean {
        return this.#active !== null;
    }

    /**
     * Hands that are dialling, or pointing and already turning (a quarter turn in the window):
     * their other hand gestures (victory, fist, ok, fingers_N, circle...) are motion artefacts
     * of the circling and must not fire rules.
     */
    circling(nowMs: number): { left: boolean; right: boolean } {
        const busy = (s: "left" | "right") => {
            if (this.#active === s) return true;
            // A short tail after a dial: the hand coming down still looks like other gestures.
            if (this.#endedSide === s && nowMs - this.#endedAt < 700) return true;
            const tr = this.#tracks[s];
            if (nowMs - tr.lastPoint > LOST_MS) return false;
            const sum = tr.steps.filter((x) => nowMs - x.t <= START_WINDOW_MS).reduce((a, x) => a + x.d, 0);
            return Math.abs(sum) >= Math.PI / 3;
        };
        // While a dial runs, the other hand's gestures are suppressed too: the circling arm
        // drags the other hand into view and the dial owns the moment.
        if (this.#active) return { left: true, right: true };
        return { left: busy("left"), right: busy("right") };
    }

    #endedSide: "left" | "right" | null = null;
    #endedAt = -Infinity;

    /** Dev trace: per-hand pointing, circle radius vs palm, turn summed over the start window. */
    debug(nowMs: number): string {
        const parts = (["left", "right"] as const).map((s) => {
            const tr = this.#tracks[s];
            const sum = tr.steps.filter((x) => nowMs - x.t <= START_WINDOW_MS).reduce((a, x) => a + x.d, 0);
            return `${s}:pt=${nowMs - tr.lastPoint < LOST_MS ? 1 : 0} n=${tr.tips.length} r=${tr.dbgR.toFixed(2)} sum=${sum.toFixed(2)} shape=${tr.dbgShape} st=${tr.dbgSt} fed=${tr.dbgFed}`;
        });
        return `active=${this.#active ?? "-"} acc=${this.#acc.toFixed(2)} ${parts.join(" ")}`;
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
                this.#endedSide = side;
                this.#endedAt = nowMs;
                this.#active = null;
                return { active: false, wish: this.#wish(), ended: true };
            }
            return { active: true, wish: this.#wish(), ended: false };
        }
        for (const s of ["right", "left"] as const) {
            const tr = this.#tracks[s];
            const win = tr.steps.filter((x) => nowMs - x.t <= START_WINDOW_MS);
            const sum = win.reduce((a, x) => a + x.d, 0);
            const moving = win.filter((x) => Math.abs(x.d) > 0.05);
            const same = moving.filter((x) => Math.sign(x.d) === Math.sign(sum)).length;
            const consistent = moving.length >= 3 && same / moving.length >= START_CONSISTENCY;
            if (Math.abs(sum) >= DIAL_START_RAD && consistent && !blocked(s) && nowMs - tr.lastPoint < LOST_MS) {
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
        tr.dbgShape = h.shape ?? "-";
        tr.dbgFed++;
        tr.dbgSt = fingerStraightness(h.world)
            .map((e) => e.toFixed(2))
            .join(",");
        // While dialling, the circling itself is the intent: a blurred frame that does not look
        // like pointing must not end it (only stopping or losing the hand does).
        const dialling = this.#active === h.side;
        if (!tip || !w || !m || (!dialling && !isIndexPointing(h.world, h.shape))) {
            // Not pointing: after a short grace, forget the circle so a new one starts clean.
            if (t - tr.lastPoint > LOST_MS) {
                tr.tips = [];
                tr.lastAngle = null;
                tr.steps = [];
            }
            return;
        }
        tr.lastPoint = t;
        tr.tips.push({ t, x: tip.x, y: tip.y });
        while (tr.tips.length > 0 && t - (tr.tips[0]?.t ?? t) > CENTRE_WINDOW_MS) tr.tips.shift();
        tr.steps = tr.steps.filter((x) => t - x.t <= START_WINDOW_MS);
        if (tr.tips.length < 3) return;
        const palm = Math.max(Math.hypot(m.x - w.x, m.y - w.y), 1e-6);
        const { x: cx, y: cy } = circleCentre(tr.tips, 3 * palm);
        const r = Math.hypot(tip.x - cx, tip.y - cy);
        tr.dbgR = r / palm;
        if (r < MIN_RADIUS_PALM * palm) {
            tr.lastAngle = null;
            return;
        }
        // RAW camera coords (never mirrored, y down): the camera faces you, so a circle that is
        // clockwise from YOUR view is counter-clockwise in its image -> negate (+ = zoom in).
        const a = -Math.atan2(tip.y - cy, tip.x - cx);
        if (tr.lastAngle !== null) {
            const d = wrap(a - tr.lastAngle);
            // A jump this big between samples is a tracking glitch, not a turn.
            if (Math.abs(d) < MAX_STEP_RAD) {
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
