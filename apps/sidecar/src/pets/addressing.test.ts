import { describe, expect, it } from "vitest";

import { classifyAddress, PARTNER_TTL_MS, type AddressContext } from "./addressing.js";

const NOW = 1_000_000;
const ctx = (over: Partial<AddressContext> = {}): AddressContext => ({
    pets: ["fox", "cat"],
    nicknames: { cat: ["Miți"] },
    chatUsers: ["Ana", "ion_99"],
    chatMessages: [],
    partner: null,
    now: NOW,
    ...over,
});

describe("classifyAddress", () => {
    it("a Romanian vocative on the species name addresses that pet", () => {
        const r = classifyAddress("Vulpițo, ce faci azi?", ctx());
        expect(r).toMatchObject({ target: "pet", pets: ["fox"] });
        expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("a streamer nickname (diacritic-insensitive, whole word) addresses the pet; its vocative too", () => {
        expect(classifyAddress("miti, vino aici", ctx())).toMatchObject({ target: "pet", pets: ["cat"] });
        expect(classifyAddress("Mițo, ești somnoroasă?", ctx())).toMatchObject({ target: "pet", pets: ["cat"] });
        expect(classifyAddress("mitingul de azi", ctx()).target).not.toBe("pet");
    });

    it("a second-person follow-up goes to the conversation partner within 20 s, not after", () => {
        const partner = { pet: "fox", at: NOW - 5_000, spoke: true };
        const r = classifyAddress("și tu ce zici?", ctx({ partner }));
        expect(r).toMatchObject({ target: "pet", pets: ["fox"] });
        expect(r.confidence).toBeGreaterThanOrEqual(0.7);
        expect(classifyAddress("și tu ce zici?", ctx({ partner: { ...partner, at: NOW - PARTNER_TTL_MS - 1 } })).target).toBe("unknown");
    });

    it("a question right after a pet line goes to that pet", () => {
        expect(classifyAddress("serios?", ctx({ partner: { pet: "cat", at: NOW - 2_000, spoke: true } }))).toMatchObject({ target: "pet", pets: ["cat"] });
    });

    it("reading a chat comment aloud is talking to the chat", () => {
        const r = classifyAddress("de unde ești din ce oraș", ctx({ chatMessages: ["de unde esti? din ce oras?"], partner: { pet: "fox", at: NOW - 1_000, spoke: true } }));
        expect(r.target).toBe("chat");
        expect(classifyAddress("Ana zice că e frig la ea", ctx({ chatUsers: [] })).target).toBe("chat");
    });

    it("a viewer's name beats a generic second person", () => {
        const r = classifyAddress("Ana, tu de unde ești?", ctx({ partner: { pet: "fox", at: NOW - 1_000, spoke: true } }));
        expect(r).toMatchObject({ target: "chat", pets: [] });
    });

    it("audience words (voi / chat / băieți / mulțumesc pentru follow) are talking to the chat", () => {
        expect(classifyAddress("voi ce părere aveți?", ctx()).target).toBe("chat");
        expect(classifyAddress("chat, ce jucăm azi", ctx()).target).toBe("chat");
        expect(classifyAddress("băieți, mersi", ctx()).target).toBe("chat");
        expect(classifyAddress("mulțumesc pentru follow", ctx()).target).toBe("chat");
        expect(classifyAddress("bine ați venit", ctx()).target).toBe("chat");
    });

    it("an explicit pet name beats chat cues", () => {
        const r = classifyAddress("pisico, spune-le băieților salut", ctx());
        expect(r).toMatchObject({ target: "pet", pets: ["cat"] });
    });

    it("English equivalents: hey cat / you follow-up / guys / chat", () => {
        expect(classifyAddress("hey cat, are you hungry?", ctx())).toMatchObject({ target: "pet", pets: ["cat"] });
        expect(classifyAddress("what do you think?", ctx({ partner: { pet: "fox", at: NOW - 3_000, spoke: false } }))).toMatchObject({ target: "pet", pets: ["fox"] });
        expect(classifyAddress("thanks guys", ctx()).target).toBe("chat");
        expect(classifyAddress("chat, what should we play", ctx()).target).toBe("chat");
    });

    it("plain narration with no partner is unknown", () => {
        expect(classifyAddress("acum mergem la nivelul următor", ctx())).toMatchObject({ target: "unknown", confidence: 0 });
        expect(classifyAddress("", ctx()).target).toBe("unknown");
    });
});
