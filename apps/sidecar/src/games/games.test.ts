import { defaultSettings, nextEventId, type ChatEvent, type GameState } from "@tiksee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_WHEEL_SEGMENTS, castVote, drawWheel, hasKeyword, matchesAnswer, newTally, normalizeAnswer, parseVote } from "./logic.js";
import { GameManager, WHEEL_SPIN_MS } from "./manager.js";

function chat(text: string, user: string, extra: Partial<ChatEvent> = {}): ChatEvent {
    return { id: nextEventId(), kind: "chat", user: { id: user, uniqueId: user, nickname: user.toUpperCase() }, text, at: 5, streamId: "main", ...extra };
}

/** Deterministic PRNG for the wheel tests. */
function seeded(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
    };
}

describe("parseVote", () => {
    it("accepts bare numbers with light decoration", () => {
        expect(parseVote("2", 3)).toBe(1);
        expect(parseVote(" #3 ", 3)).toBe(2);
        expect(parseVote("!1", 3)).toBe(0);
        expect(parseVote("2!!", 3)).toBe(1);
        expect(parseVote("1 👍", 3)).toBe(0);
    });

    it("rejects out-of-range numbers and sentences", () => {
        expect(parseVote("4", 3)).toBeNull();
        expect(parseVote("0", 3)).toBeNull();
        expect(parseVote("2 pisici", 3)).toBeNull();
        expect(parseVote("12", 3)).toBeNull();
        expect(parseVote("am 2 ani", 3)).toBeNull();
        expect(parseVote("2a", 3)).toBeNull();
    });
});

describe("castVote", () => {
    it("counts one vote per viewer and optionally lets them change it", () => {
        const tally = newTally(3);
        expect(castVote(tally, "ana", 0, false)).toBe(true);
        expect(castVote(tally, "ana", 1, false)).toBe(false);
        expect(tally.votes).toEqual([1, 0, 0]);
        expect(castVote(tally, "ana", 1, true)).toBe(true);
        expect(castVote(tally, "ion", 1, true)).toBe(true);
        expect(tally.votes).toEqual([0, 2, 0]);
        expect(castVote(tally, "", 1, true)).toBe(false);
    });
});

describe("quiz matching", () => {
    it("normalises diacritics, case and punctuation", () => {
        expect(normalizeAnswer("  Brașov!!  ")).toBe("brasov");
        expect(matchesAnswer("BRASOV", ["Brașov"])).toBe(true);
        expect(matchesAnswer("cred că e brașov?", ["Brașov"])).toBe(true);
    });

    it("does not match partial words or short answers inside sentences", () => {
        expect(matchesAnswer("brasoveni", ["Brașov"])).toBe(false);
        expect(matchesAnswer("e 42 sigur", ["42"])).toBe(false);
        expect(matchesAnswer("42", ["42"])).toBe(true);
        expect(matchesAnswer("", ["x"])).toBe(false);
    });

    it("finds the wheel keyword as a whole word", () => {
        expect(hasKeyword("vreau și eu TOMBOLA", "tombolă")).toBe(true);
        expect(hasKeyword("tombolanta", "tombola")).toBe(false);
    });
});

describe("drawWheel", () => {
    const players = (n: number) => Array.from({ length: n }, (_, i) => ({ uniqueId: `u${i}`, nickname: `P${i}` }));

    it("returns null with no entrants", () => {
        expect(drawWheel([])).toBeNull();
    });

    it("always places the winner at winnerIndex and caps the segments", () => {
        for (const n of [1, 5, 24, 25, 300]) {
            const draw = drawWheel(players(n), seeded(n));
            expect(draw).not.toBeNull();
            if (!draw) continue;
            expect(draw.segments.length).toBe(Math.min(n, MAX_WHEEL_SEGMENTS));
            expect(draw.segments[draw.winnerIndex]).toBe(draw.winner.nickname);
            expect(new Set(draw.segments).size).toBe(draw.segments.length);
        }
    });

    it("gives every entrant a chance", () => {
        const rng = seeded(7);
        const wins = new Set<string>();
        for (let i = 0; i < 400; i += 1) wins.add(drawWheel(players(5), rng)?.winner.uniqueId ?? "");
        expect(wins.size).toBe(5);
    });
});

describe("GameManager", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function setup() {
        const settings = defaultSettings();
        const states: GameState[] = [];
        const said: string[] = [];
        const manager = new GameManager({ settings: () => settings, emit: (s) => states.push(s), announce: (t) => said.push(t), rng: seeded(3) });
        return { settings, states, said, manager };
    }

    it("runs a poll and announces the winning option on close", () => {
        const { manager, said } = setup();
        manager.start({ kind: "poll", question: "Ce joc?", options: ["Minecraft", "Fortnite"] });
        manager.onEvent(chat("2", "a"));
        manager.onEvent(chat("2", "b"));
        manager.onEvent(chat("1", "c"));
        manager.onEvent(chat("hello", "d"));
        const state = manager.state;
        expect(state.kind === "poll" && state.options.map((o) => o.votes)).toEqual([1, 2]);
        manager.action("close");
        manager.onEvent(chat("1", "e"));
        expect(manager.state.kind === "poll" && manager.state.totalVotes).toBe(3);
        expect(said[0]).toContain("Fortnite");
        manager.dispose();
    });

    it("quiz: first correct answer wins and closes the round", () => {
        const { manager, said } = setup();
        manager.start({ kind: "quiz", question: "Capitala Franței?", answers: ["Paris"] });
        manager.onEvent(chat("Londra", "a"));
        manager.onEvent(chat("paris!", "b"));
        manager.onEvent(chat("Paris", "c"));
        const state = manager.state;
        expect(state.kind === "quiz" && state.winner?.uniqueId).toBe("b");
        expect(state.kind === "quiz" && state.attempts).toBe(2);
        expect(state.kind === "quiz" && state.answer).toBe("Paris");
        expect(said).toHaveLength(1);
        manager.dispose();
    });

    it("wheel: collects keyword entrants once, spins, reveals after the animation", () => {
        vi.useFakeTimers();
        const { manager, settings, said } = setup();
        settings.games.wheelFollowersOnly = true;
        manager.start({ kind: "wheel", keyword: "tombola" });
        manager.onEvent(chat("tombola", "a", { user: { id: "a", uniqueId: "a", nickname: "A", isFollower: true } }));
        manager.onEvent(chat("tombola", "a", { user: { id: "a", uniqueId: "a", nickname: "A", isFollower: true } }));
        manager.onEvent(chat("tombola", "b"));
        manager.onEvent(chat("TOMBOLA pls", "c", { user: { id: "c", uniqueId: "c", nickname: "C", isFollower: true } }));
        expect(manager.state.kind === "wheel" && manager.state.entrantCount).toBe(2);
        manager.action("spin");
        const spinning = manager.state;
        expect(spinning.kind === "wheel" && spinning.spinning).toBe(true);
        expect(spinning.kind === "wheel" && spinning.winner).toBeUndefined();
        vi.advanceTimersByTime(WHEEL_SPIN_MS);
        const done = manager.state;
        expect(done.kind === "wheel" && done.spinning).toBe(false);
        expect(done.kind === "wheel" && ["a", "c"].includes(done.winner?.uniqueId ?? "")).toBe(true);
        expect(said).toHaveLength(1);
        manager.action("clear");
        expect(manager.state).toEqual({ kind: "none" });
        manager.dispose();
    });

    it("stays silent when announcements are off", () => {
        const { manager, settings, said } = setup();
        settings.games.announceWinners = false;
        manager.start({ kind: "quiz", question: "?", answers: ["da"] });
        manager.onEvent(chat("da", "a"));
        expect(said).toEqual([]);
        manager.dispose();
    });
});
