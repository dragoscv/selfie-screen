import { beforeEach, describe, expect, it } from "vitest";

import type { ChatEvent } from "./events.js";
import { Moderator, compileWordList, normaliseForMatch } from "./moderation.js";

function ev(text: string, uniqueId = "ana", at = 1000): ChatEvent {
    return {
        id: `${uniqueId}-${at}-${text.length}`,
        kind: "chat",
        user: { id: uniqueId, uniqueId, nickname: uniqueId },
        text,
        at,
        streamId: "s1",
    };
}

const BASE = {
    blockedWords: [] as string[],
    blockedUsers: [] as string[],
    alertKeywords: [] as string[],
    hideSpam: false,
    spamWindowMs: 15_000,
};

describe("normaliseForMatch", () => {
    it("lowercases and strips Romanian diacritics", () => {
        expect(normaliseForMatch("Șarpe ÎnȚepat")).toBe("sarpe intepat");
    });

    it("folds leetspeak substitutions", () => {
        expect(normaliseForMatch("h4ck3r")).toBe("hacker");
        expect(normaliseForMatch("5p4m")).toBe("spam");
    });
});

describe("compileWordList", () => {
    it("returns null for an empty list", () => {
        expect(compileWordList([])).toBeNull();
        expect(compileWordList(["", "   "])).toBeNull();
    });

    it("matches on word boundaries by default", () => {
        const re = compileWordList(["ass"]);
        expect(re?.test("what an ass")).toBe(true);
        expect(re?.test("password")).toBe(false);
    });

    it("supports substring matching when wrapped in asterisks", () => {
        const re = compileWordList(["*spam*"]);
        expect(re?.test("antispamming")).toBe(true);
    });

    it("escapes regex metacharacters in user input", () => {
        const re = compileWordList(["a+b"]);
        expect(re?.test("a+b")).toBe(true);
        expect(re?.test("aaab")).toBe(false);
    });
});

describe("Moderator", () => {
    let mod: Moderator;

    beforeEach(() => {
        mod = new Moderator({ ...BASE });
    });

    it("allows an ordinary message", () => {
        expect(mod.evaluate(ev("hello there"))).toEqual({ blocked: false, alert: false });
    });

    it("blocks a message containing a blocked word", () => {
        mod.setRules({ ...BASE, blockedWords: ["badword"] });
        const verdict = mod.evaluate(ev("this is a badword here"));
        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe("word");
    });

    it("catches evasion via diacritics and leetspeak", () => {
        mod.setRules({ ...BASE, blockedWords: ["spam"] });
        expect(mod.evaluate(ev("5p4m")).blocked).toBe(true);
    });

    it("blocks a blocked user regardless of content", () => {
        mod.setRules({ ...BASE, blockedUsers: ["@Troll"] });
        const verdict = mod.evaluate(ev("perfectly nice message", "troll"));
        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe("user");
    });

    it("flags alert keywords without blocking", () => {
        mod.setRules({ ...BASE, alertKeywords: ["giveaway"] });
        const verdict = mod.evaluate(ev("is there a giveaway?"));
        expect(verdict.blocked).toBe(false);
        expect(verdict.alert).toBe(true);
    });

    it("detects repeated identical messages as spam", () => {
        mod.setRules({ ...BASE, hideSpam: true });
        expect(mod.evaluate(ev("buy now", "bot", 1000)).blocked).toBe(false);
        const second = mod.evaluate(ev("buy now", "bot", 2000));
        expect(second.blocked).toBe(true);
        expect(second.reason).toBe("spam");
    });

    it("allows a repeat once the spam window has passed", () => {
        mod.setRules({ ...BASE, hideSpam: true, spamWindowMs: 5_000 });
        expect(mod.evaluate(ev("hi", "bot", 1000)).blocked).toBe(false);
        expect(mod.evaluate(ev("hi", "bot", 20_000)).blocked).toBe(false);
    });

    it("does not treat different users repeating a phrase as spam", () => {
        mod.setRules({ ...BASE, hideSpam: true });
        expect(mod.evaluate(ev("gg", "ana", 1000)).blocked).toBe(false);
        expect(mod.evaluate(ev("gg", "mihai", 1100)).blocked).toBe(false);
    });

    it("never treats gifts as spam", () => {
        mod.setRules({ ...BASE, hideSpam: true });
        const gift: ChatEvent = { ...ev("sent a Rose", "ana", 1000), kind: "gift" };
        expect(mod.evaluate(gift).blocked).toBe(false);
        expect(mod.evaluate({ ...gift, at: 1100 }).blocked).toBe(false);
    });

    it("clears spam memory on reset", () => {
        mod.setRules({ ...BASE, hideSpam: true });
        mod.evaluate(ev("dup", "bot", 1000));
        mod.reset();
        expect(mod.evaluate(ev("dup", "bot", 1100)).blocked).toBe(false);
    });
});
