import { describe, expect, it } from "vitest";

import type { ChatEvent } from "./events.js";
import { diamondsToUsd, eventDiamonds, giftDiamonds } from "./gifts.js";

function gift(partial: Partial<ChatEvent>): ChatEvent {
    return {
        id: "g1",
        kind: "gift",
        user: { id: "1", uniqueId: "ana", nickname: "Ana" },
        text: "sent a gift",
        at: 1000,
        streamId: "s1",
        ...partial,
    };
}

describe("giftDiamonds", () => {
    it("looks up known gifts case-insensitively", () => {
        expect(giftDiamonds("Rose")).toBe(1);
        expect(giftDiamonds("  ROSE  ")).toBe(1);
        expect(giftDiamonds("finger heart")).toBe(5);
    });

    it("returns 0 for unknown or missing gifts", () => {
        expect(giftDiamonds("Definitely Not A Gift")).toBe(0);
        expect(giftDiamonds(undefined)).toBe(0);
    });
});

describe("eventDiamonds", () => {
    it("is zero for non-gift events", () => {
        expect(eventDiamonds(gift({ kind: "chat" }))).toBe(0);
    });

    it("prefers the value reported by the protocol", () => {
        expect(eventDiamonds(gift({ giftName: "Rose", giftDiamonds: 7, giftCount: 3 }))).toBe(21);
    });

    it("falls back to the catalogue when the protocol omits the value", () => {
        expect(eventDiamonds(gift({ giftName: "Rose", giftCount: 10 }))).toBe(10);
    });

    it("treats a missing count as one", () => {
        expect(eventDiamonds(gift({ giftName: "Galaxy" }))).toBe(1000);
    });

    it("is zero for an unknown gift with no reported value", () => {
        expect(eventDiamonds(gift({ giftName: "Mystery Box", giftCount: 5 }))).toBe(0);
    });
});

describe("diamondsToUsd", () => {
    it("uses the default half-cent rate", () => {
        expect(diamondsToUsd(1000)).toBe(5);
    });

    it("honours a custom rate and rounds to cents", () => {
        expect(diamondsToUsd(333, 0.01)).toBe(3.33);
    });

    it("is zero for zero diamonds", () => {
        expect(diamondsToUsd(0)).toBe(0);
    });
});
