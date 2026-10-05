import { eventDiamonds, type ChatEvent, type GoalKind, type GoalProgress, type GoalsState, type Settings } from "@tiksee/core";

/**
 * Stream goals (WS20-08): diamond and like counters measured against the
 * streamer's targets. Pure state + a throttled emitter so a like storm costs
 * one frame per interval, not one per event.
 */

export interface GoalCounters {
    gifts: number;
    likes: number;
}

/** Progress of one goal; `target` is clamped to >= 1 so the ratio is defined. */
export function goalProgress(kind: GoalKind, label: string, current: number, target: number): GoalProgress {
    const safeTarget = Math.max(1, Math.round(target));
    const safeCurrent = Math.max(0, Math.round(current));
    return {
        kind,
        label,
        current: safeCurrent,
        target: safeTarget,
        ratio: Math.min(1, safeCurrent / safeTarget),
        reached: safeCurrent >= safeTarget,
    };
}

/** Add one live event to the counters; returns true when something changed. */
export function countEvent(counters: GoalCounters, event: ChatEvent): boolean {
    if (event.kind === "gift") {
        const diamonds = eventDiamonds(event);
        if (diamonds <= 0) return false;
        counters.gifts += diamonds;
        return true;
    }
    if (event.kind === "like") {
        counters.likes += Math.max(1, event.likeCount ?? 1);
        return true;
    }
    return false;
}

export function goalsState(settings: Settings, counters: GoalCounters): GoalsState {
    const { goals } = settings;
    const list: GoalProgress[] = [];
    if (goals.gifts.enabled) list.push(goalProgress("gifts", goals.gifts.label, counters.gifts, goals.gifts.target));
    if (goals.likes.enabled) list.push(goalProgress("likes", goals.likes.label, counters.likes, goals.likes.target));
    return { enabled: goals.enabled, overlay: goals.enabled && goals.showInOverlay, goals: list };
}

/** Kinds that crossed their target between two states, for one-shot celebrations. */
export function newlyReached(before: GoalsState, after: GoalsState): GoalKind[] {
    const was = new Set(before.goals.filter((g) => g.reached).map((g) => g.kind));
    return after.goals.filter((g) => g.reached && !was.has(g.kind)).map((g) => g.kind);
}

export interface GoalTrackerDeps {
    settings: () => Settings;
    emit: (state: GoalsState) => void;
    onReached?: (kind: GoalKind, progress: GoalProgress) => void;
    intervalMs?: number;
}

export class GoalTracker {
    #deps: GoalTrackerDeps;
    #counters: GoalCounters = { gifts: 0, likes: 0 };
    #last: GoalsState;
    #timer: NodeJS.Timeout | null = null;

    constructor(deps: GoalTrackerDeps) {
        this.#deps = deps;
        this.#last = goalsState(deps.settings(), this.#counters);
    }

    get state(): GoalsState {
        return this.#last;
    }

    onEvent(event: ChatEvent): void {
        if (countEvent(this.#counters, event)) this.#schedule();
    }

    reset(): void {
        this.#counters = { gifts: 0, likes: 0 };
        this.flush();
    }

    settingsChanged(): void {
        this.flush();
    }

    /** Recompute and emit now. */
    flush(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        const next = goalsState(this.#deps.settings(), this.#counters);
        const reached = next.enabled ? newlyReached(this.#last, next) : [];
        this.#last = next;
        this.#deps.emit(next);
        for (const kind of reached) {
            const progress = next.goals.find((g) => g.kind === kind);
            if (progress) this.#deps.onReached?.(kind, progress);
        }
    }

    dispose(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
    }

    #schedule(): void {
        if (this.#timer) return;
        this.#timer = setTimeout(() => this.flush(), this.#deps.intervalMs ?? 250);
        this.#timer.unref();
    }
}
