import { compileWordList, nextEventId, type ChatEvent, type ChatKind } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { DuplicateTracker, decayed, isQuestion, mentions, scoreEvent, type ScoreContext } from "./scorer.js";

function ev(kind: ChatKind, text: string, extra: Partial<ChatEvent> = {}, user: Partial<ChatEvent["user"]> = {}): ChatEvent {
    return {
        id: nextEventId(),
        kind,
        user: { id: "1", uniqueId: "ana", nickname: "Ana", ...user },
        text,
        at: 0,
        streamId: "main",
        ...extra,
    };
}

const base: ScoreContext = {
    personaName: "codai",
    streamerHandle: "dragos",
    firstThisSession: false,
    firstEver: false,
    duplicate: false,
    blocked: null,
};

describe("isQuestion", () => {
    it.each([
        "ce faci?",
        "Cum te cheamă",
        "de ce ai ales asta",
        "când începe concursul",
        "unde locuiești",
        "cât costă",
        "what game is this",
        "how old are you",
        "merge?",
    ])("detects %s", (text) => {
        expect(isQuestion(text)).toBe(true);
    });
    it.each(["salut", "super tare", "cele mai bune", "whatever man"])("rejects %s", (text) => {
        expect(isQuestion(text)).toBe(false);
    });
});

describe("mentions", () => {
    it("matches the persona name as a word and the streamer handle", () => {
        expect(mentions("Codai, salut!", "codai", "dragos")).toBe(true);
        expect(mentions("hei @codai", "codai", "dragos")).toBe(true);
        expect(mentions("codaix nu", "codai", "dragos")).toBe(false);
        expect(mentions("@dragos ce faci", "codai", "dragos")).toBe(true);
        expect(mentions("dragos", "codai", "dragos")).toBe(false);
    });
});

describe("scoreEvent", () => {
    it("ranks a question above plain chat and explains why", () => {
        const plain = scoreEvent(ev("chat", "salut tuturor"), base);
        const question = scoreEvent(ev("chat", "ce joc e asta?"), base);
        expect(question.score).toBeGreaterThan(plain.score);
        expect(question.reasons).toContain("question");
    });

    it("log-scales gift value", () => {
        const rose = scoreEvent(ev("gift", "sent Rose", { giftDiamonds: 1, giftCount: 1 }), base);
        const lion = scoreEvent(ev("gift", "sent Lion", { giftDiamonds: 29_999, giftCount: 1 }), base);
        expect(lion.score).toBeGreaterThan(rose.score);
        expect(lion.score).toBeLessThan(rose.score * 5);
        expect(lion.reasons).toEqual(["gift"]);
    });

    it("rewards first-time viewers, mentions and badges", () => {
        const result = scoreEvent(ev("chat", "salut codai", {}, { isSubscriber: true, isModerator: true }), { ...base, firstEver: true });
        expect(result.reasons).toEqual(expect.arrayContaining(["mention", "first-time", "subscriber", "moderator"]));
        const today = scoreEvent(ev("chat", "salut"), { ...base, firstThisSession: true });
        expect(today.reasons).toContain("first-today");
    });

    it("excludes duplicates, blocked words, empty text and passive kinds", () => {
        expect(scoreEvent(ev("chat", "ce faci?"), { ...base, duplicate: true }).excluded).toBe("duplicate");
        expect(scoreEvent(ev("chat", "esti un idiot?"), { ...base, blocked: compileWordList(["idiot"]) }).excluded).toBe("blocked");
        expect(scoreEvent(ev("chat", "   "), base).excluded).toBe("empty");
        expect(scoreEvent(ev("like", "liked"), base).excluded).toBe("kind");
        expect(scoreEvent(ev("join", "joined"), base).excluded).toBe("kind");
    });

    it("is fast: 10k events well under 5 ms each", () => {
        const events = Array.from({ length: 10_000 }, (_, i) => ev("chat", `mesaj numarul ${i} ce faci azi?`));
        const started = performance.now();
        for (const event of events) scoreEvent(event, base);
        expect((performance.now() - started) / events.length).toBeLessThan(0.5);
    });
});

describe("decayed", () => {
    it("halves every 30 s", () => {
        expect(decayed(8, 0, 0)).toBe(8);
        expect(decayed(8, 0, 30_000)).toBeCloseTo(4);
        expect(decayed(8, 0, 60_000)).toBeCloseTo(2);
    });
});

describe("DuplicateTracker", () => {
    it("flags repeats inside the window regardless of case/diacritics", () => {
        const tracker = new DuplicateTracker(60_000);
        expect(tracker.check("Mulțumesc!", 0)).toBe(false);
        expect(tracker.check("multumesc!", 1_000)).toBe(true);
        expect(tracker.check("multumesc!", 70_000)).toBe(false);
    });
});
