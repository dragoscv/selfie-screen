import { boxCentre, iou, type Box } from "./geometry.js";

/**
 * Multi-subject tracker: greedy assignment of detections to existing tracks by
 * IoU, falling back to centroid distance (relative to box size) for fast
 * motion. Track ids are stable for the session and never reused.
 *
 * Presence edges: a track is "present" after `enterMs` of continuous
 * detection and "left" after `leaveMs` without one. Boxes are any consistent
 * unit (we use normalised upright coords).
 */
export interface TrackOptions {
    enterMs: number;
    leaveMs: number;
    minIou: number;
    /** Max centre distance, in units of the track box diagonal. */
    maxCentreDist: number;
}

export const DEFAULT_TRACKS: TrackOptions = { enterMs: 1000, leaveMs: 3000, minIou: 0.2, maxCentreDist: 0.8 };

export interface Track<T> {
    id: number;
    box: Box;
    /** The payload of the latest detection assigned to this track. */
    data: T;
    firstSeen: number;
    lastSeen: number;
    present: boolean;
    /** Detected in the latest update. */
    visible: boolean;
}

export interface TrackEvents<T> {
    entered: Track<T>[];
    left: Track<T>[];
}

export class SubjectTracker<T> {
    readonly #o: TrackOptions;
    #tracks: Track<T>[] = [];
    #nextId: number;

    constructor(options: Partial<TrackOptions> = {}, firstId = 0) {
        this.#o = { ...DEFAULT_TRACKS, ...options };
        this.#nextId = firstId;
    }

    get tracks(): readonly Track<T>[] {
        return this.#tracks;
    }

    /** Assign this frame's detections; returns presence edges. */
    update(detections: readonly { box: Box; data: T }[], tMs: number): TrackEvents<T> {
        const o = this.#o;
        const pairs: { t: number; d: number; cost: number }[] = [];
        this.#tracks.forEach((tr, ti) => {
            detections.forEach((det, di) => {
                const ov = iou(tr.box, det.box);
                const a = boxCentre(tr.box);
                const b = boxCentre(det.box);
                const diag = Math.hypot(tr.box.w, tr.box.h) || 1;
                const cd = Math.hypot(a.x - b.x, a.y - b.y) / diag;
                if (ov >= o.minIou || cd <= o.maxCentreDist) pairs.push({ t: ti, d: di, cost: (1 - ov) + cd });
            });
        });
        pairs.sort((x, y) => x.cost - y.cost);
        const usedT = new Set<number>();
        const usedD = new Set<number>();
        for (const tr of this.#tracks) tr.visible = false;
        for (const p of pairs) {
            if (usedT.has(p.t) || usedD.has(p.d)) continue;
            usedT.add(p.t);
            usedD.add(p.d);
            const tr = this.#tracks[p.t];
            const det = detections[p.d];
            if (!tr || !det) continue;
            tr.box = det.box;
            tr.data = det.data;
            tr.lastSeen = tMs;
            tr.visible = true;
        }
        detections.forEach((det, di) => {
            if (usedD.has(di)) return;
            this.#tracks.push({ id: this.#nextId++, box: det.box, data: det.data, firstSeen: tMs, lastSeen: tMs, present: false, visible: true });
        });

        const entered: Track<T>[] = [];
        const left: Track<T>[] = [];
        const keep: Track<T>[] = [];
        for (const tr of this.#tracks) {
            const gone = tMs - tr.lastSeen;
            if (!tr.present && tr.visible && tMs - tr.firstSeen >= o.enterMs) {
                tr.present = true;
                entered.push(tr);
            }
            if (gone >= o.leaveMs) {
                if (tr.present) left.push(tr);
                continue;
            }
            // A never-confirmed track that blinked out is dropped quietly (detector noise).
            if (!tr.present && !tr.visible && gone > o.enterMs) continue;
            keep.push(tr);
        }
        this.#tracks = keep;
        return { entered, left };
    }

    clear(): Track<T>[] {
        const left = this.#tracks.filter((t) => t.present);
        this.#tracks = [];
        return left;
    }
}

/**
 * Which track is the owner: the one matched to the owner profile when identity
 * is on; otherwise the visible track with the best mix of size, centrality and
 * time present (the streamer sits in front of their own camera).
 */
export function pickOwner<T>(tracks: readonly Track<T>[], tMs: number, ownerTrack?: number | null): number | null {
    if (ownerTrack !== undefined && ownerTrack !== null && tracks.some((t) => t.id === ownerTrack && tMs - t.lastSeen < 3000)) return ownerTrack;
    let best: number | null = null;
    let bestScore = -Infinity;
    for (const t of tracks) {
        if (!t.visible) continue;
        const c = boxCentre(t.box);
        const area = t.box.w * t.box.h;
        const central = 1 - Math.min(1, Math.hypot(c.x - 0.5, c.y - 0.45) / 0.7);
        const age = Math.min(1, (tMs - t.firstSeen) / 10_000);
        const score = 2 * Math.sqrt(area) + 0.6 * central + 0.4 * age;
        if (score > bestScore) {
            bestScore = score;
            best = t.id;
        }
    }
    return best;
}
