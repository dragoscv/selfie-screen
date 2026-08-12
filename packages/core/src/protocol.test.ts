import { describe, expect, it } from "vitest";

import { nextEventId } from "./events.js";
import { parseClientMessage, parseServerMessage } from "./protocol.js";

describe("protocol", () => {
    it("parses a valid connect message", () => {
        const msg = parseClientMessage(
            JSON.stringify({ type: "connect", streamId: "s1", username: "someone" }),
        );
        expect(msg?.type).toBe("connect");
        // Defaults are applied at the boundary so handlers never see undefined.
        expect(msg).toMatchObject({ driver: "connector", waitUntilLive: false });
    });

    it("rejects an unknown message type", () => {
        expect(parseClientMessage(JSON.stringify({ type: "definitelyNotReal" }))).toBeNull();
    });

    it("rejects a message missing required fields", () => {
        expect(parseClientMessage(JSON.stringify({ type: "connect" }))).toBeNull();
    });

    it("rejects malformed JSON rather than throwing", () => {
        expect(parseClientMessage("{not json")).toBeNull();
        expect(parseServerMessage("")).toBeNull();
    });

    it("parses a batched events frame", () => {
        const frame = {
            type: "events",
            events: [
                {
                    id: "a",
                    kind: "chat",
                    user: { id: "1", uniqueId: "ana", nickname: "Ana" },
                    text: "hi",
                    at: 1,
                    streamId: "s1",
                },
            ],
        };
        const msg = parseServerMessage(JSON.stringify(frame));
        expect(msg?.type).toBe("events");
    });

    it("rejects an event with an invalid kind", () => {
        const frame = {
            type: "events",
            events: [
                {
                    id: "a",
                    kind: "explosion",
                    user: { id: "1", uniqueId: "ana", nickname: "Ana" },
                    text: "hi",
                    at: 1,
                    streamId: "s1",
                },
            ],
        };
        expect(parseServerMessage(JSON.stringify(frame))).toBeNull();
    });

    it("validates the panel brightness range", () => {
        expect(parseClientMessage(JSON.stringify({ type: "panelBrightness", level: 50 }))).not.toBeNull();
        expect(parseClientMessage(JSON.stringify({ type: "panelBrightness", level: 500 }))).toBeNull();
    });
});

describe("nextEventId", () => {
    it("never collides within the same millisecond", () => {
        const ids = new Set(Array.from({ length: 5000 }, () => nextEventId(1_700_000_000_000)));
        expect(ids.size).toBe(5000);
    });
});
