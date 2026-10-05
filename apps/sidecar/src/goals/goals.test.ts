import { defaultSettings, nextEventId, type ChatEvent, type GoalsState } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { GoalTracker, countEvent, goalProgress, goalsState, newlyReached } from "./goals.js";

function gift(diamonds: number, count = 1): ChatEvent {
    return {
        id: nextEventId(),
        kind: "gift",
        user: { id: "a", uniqueId: "a", nickname: "A" },
        text: "gift",
        at: 1,
        streamId: "main",
        giftDiamonds: diamonds,
        giftCount: count,
    };
}
function like(count?: number): ChatEvent {
    return { id: nextEventId(), kind: "like", user: { id: "b", uniqueId: "b", nickname: "B" }, text: "like", at: 1, streamId: "main", ...(count === undefined ? {} : { likeCount: count }) };
}

describe("goalProgress", () => {
    it("clamps ratio to 1 and flags reached at the target", () => {
        expect(goalProgress("gifts", "", 50, 100)).toMatchObject({ ratio: 0.5, reached: false });
        expect(goalProgress("gifts", "", 100, 100)).toMatchObject({ ratio: 1, reached: true });
        expect(goalProgress("likes", "", 500, 100)).toMatchObject({ ratio: 1, reached: true, current: 500 });
    });

    it("never divides by zero or goes negative", () => {
        expect(goalProgress("likes", "", -5, 0)).toMatchObject({ current: 0, target: 1, ratio: 0 });
    });
});

describe("countEvent", () => {
    it("adds gift diamonds times combo count and like batches", () => {
        const c = { gifts: 0, likes: 0 };
        expect(countEvent(c, gift(5, 3))).toBe(true);
        expect(countEvent(c, like(15))).toBe(true);
        expect(countEvent(c, like())).toBe(true);
        expect(c).toEqual({ gifts: 15, likes: 16 });
    });

    it("ignores chat and zero-value gifts", () => {
        const c = { gifts: 0, likes: 0 };
        const chat: ChatEvent = { ...gift(1), kind: "chat" };
        expect(countEvent(c, chat)).toBe(false);
        expect(countEvent(c, gift(0))).toBe(false);
        expect(c).toEqual({ gifts: 0, likes: 0 });
    });
});

describe("goalsState", () => {
    it("lists only enabled goals and hides the overlay when goals are off", () => {
        const s = defaultSettings();
        expect(goalsState(s, { gifts: 1, likes: 1 })).toMatchObject({ enabled: false, overlay: false });
        s.goals.enabled = true;
        s.goals.likes.enabled = false;
        const state = goalsState(s, { gifts: 250, likes: 1 });
        expect(state.overlay).toBe(true);
        expect(state.goals.map((g) => g.kind)).toEqual(["gifts"]);
        expect(state.goals[0]?.ratio).toBe(0.25);
    });

    it("reports each goal crossing exactly once", () => {
        const a: GoalsState = { enabled: true, overlay: true, goals: [goalProgress("gifts", "", 90, 100)] };
        const b: GoalsState = { enabled: true, overlay: true, goals: [goalProgress("gifts", "", 110, 100)] };
        expect(newlyReached(a, b)).toEqual(["gifts"]);
        expect(newlyReached(b, b)).toEqual([]);
    });
});

describe("GoalTracker", () => {
    it("emits on flush, fires onReached once and resets", () => {
        const s = defaultSettings();
        s.goals.enabled = true;
        s.goals.gifts.target = 10;
        const emitted: GoalsState[] = [];
        const reached: string[] = [];
        const tracker = new GoalTracker({ settings: () => s, emit: (st) => emitted.push(st), onReached: (k) => reached.push(k) });
        tracker.onEvent(gift(6));
        tracker.onEvent(gift(6));
        tracker.flush();
        tracker.onEvent(gift(1));
        tracker.flush();
        expect(reached).toEqual(["gifts"]);
        expect(tracker.state.goals[0]?.current).toBe(13);
        tracker.reset();
        expect(tracker.state.goals[0]?.current).toBe(0);
        expect(emitted.length).toBe(3);
        tracker.dispose();
    });
});
