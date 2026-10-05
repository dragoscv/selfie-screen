import { describe, expect, it } from "vitest";

import { parseClientMessage, parseServerMessage } from "./protocol.js";
import { defaultSettings, parseSettings } from "./settings.js";

describe("WS20 wire contract", () => {
    it("validates game specs at the boundary", () => {
        const poll = { type: "gameStart", game: { kind: "poll", question: " Ce joc? ", options: ["A", "B"] } };
        expect(parseClientMessage(JSON.stringify(poll))).toMatchObject({ game: { question: "Ce joc?" } });
        const onePoll = { type: "gameStart", game: { kind: "poll", question: "Q", options: ["A"] } };
        expect(parseClientMessage(JSON.stringify(onePoll))).toBeNull();
        const emptyWheel = { type: "gameStart", game: { kind: "wheel", keyword: "  " } };
        expect(parseClientMessage(JSON.stringify(emptyWheel))).toBeNull();
        expect(parseClientMessage(JSON.stringify({ type: "gameAction", action: "spin" }))).not.toBeNull();
        expect(parseClientMessage(JSON.stringify({ type: "gameAction", action: "nuke" }))).toBeNull();
    });

    it("requires a path and a known format for exports", () => {
        expect(parseClientMessage(JSON.stringify({ type: "summaryExport", sessionId: 1, format: "csv", path: "C:\\x.csv" }))).not.toBeNull();
        expect(parseClientMessage(JSON.stringify({ type: "summaryExport", sessionId: 1, format: "xlsx", path: "C:\\x.xlsx" }))).toBeNull();
        expect(parseClientMessage(JSON.stringify({ type: "summaryExport", sessionId: 1, format: "csv", path: "" }))).toBeNull();
    });

    it("parses goals, game, translation and summary frames", () => {
        const goals = { type: "goals", state: { enabled: true, overlay: true, goals: [{ kind: "gifts", label: "", current: 5, target: 10, ratio: 0.5, reached: false }] } };
        expect(parseServerMessage(JSON.stringify(goals))?.type).toBe("goals");
        expect(parseServerMessage(JSON.stringify({ type: "game", state: { kind: "none" } }))?.type).toBe("game");
        expect(parseServerMessage(JSON.stringify({ type: "translation", eventId: "e", lang: "en", text: "Salut" }))?.type).toBe("translation");
        const summary = parseServerMessage(JSON.stringify({ type: "summary", error: "none" }));
        expect(summary).toMatchObject({ type: "summary", auto: false });
        const badRatio = { ...goals, state: { ...goals.state, goals: [{ ...goals.state.goals[0], ratio: 2 }] } };
        expect(parseServerMessage(JSON.stringify(badRatio))).toBeNull();
    });
});

describe("WS20 settings", () => {
    it("defaults goals, games and translation off or safe", () => {
        const s = defaultSettings();
        expect(s.goals).toEqual({
            enabled: false,
            showInOverlay: true,
            gifts: { enabled: true, label: "", target: 1000 },
            likes: { enabled: true, label: "", target: 10_000 },
        });
        expect(s.games.announceWinners).toBe(true);
        expect(s.translation).toEqual({ enabled: false, minLetters: 6 });
    });

    it("repairs an invalid goal target without losing other sections", () => {
        const parsed = parseSettings({ goals: { enabled: true, gifts: { target: -3 } }, voice: { speed: 1.2 } });
        expect(parsed.goals.gifts.target).toBe(1000);
        expect(parsed.voice.speed).toBe(1.2);
    });
});
