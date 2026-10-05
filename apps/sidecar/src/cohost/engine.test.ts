import { defaultSettings, nextEventId, type ChatEvent, type ServerMessage, type Settings } from "@tiksee/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodaiClient } from "../codai/client.js";
import { LiveControl } from "../live-control.js";
import { logger } from "../logger.js";
import { CoHost } from "./engine.js";

type Codai = Pick<CodaiClient, "streamChat" | "systemOne" | "complete">;

function chat(text: string, user = "ana", extra: Partial<ChatEvent> = {}): ChatEvent {
    return { id: nextEventId(), kind: "chat", user: { id: user, uniqueId: user, nickname: user }, text, at: Date.now(), streamId: "main", ...extra };
}

function fakeCodai(reply = "Salut! Bine ai venit."): Codai {
    return {
        streamChat: vi.fn(async (request) => {
            const sentences = reply.split(/(?<=[.!?])\s+/);
            for (const [i, s] of sentences.entries()) request.onSentence?.(s, i);
            return { ok: true as const, value: { text: reply, sentences, firstSentenceMs: 1, totalMs: 1 } };
        }),
        systemOne: vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const, message: "off" } })),
        complete: vi.fn(async () => ({ ok: true as const, value: "{}" })),
    };
}

function setup(patch: (s: Settings) => void, codai: Codai = fakeCodai()) {
    const settings = defaultSettings();
    settings.assistant.aiReplies = true;
    settings.assistant.useSystemOne = false;
    patch(settings);
    const sent: ServerMessage[] = [];
    const control = new LiveControl((state) => sent.push({ type: "liveControl", state }));
    const engine = new CoHost({
        settings: () => settings,
        send: (message) => sent.push(message),
        control,
        codai,
        memory: null,
        log: logger.scoped("[test]"),
    });
    const says = () => sent.filter((m): m is Extract<ServerMessage, { type: "say" }> => m.type === "say");
    return { settings, engine, control, sent, says, codai };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CoHost", () => {
    let engines: CoHost[] = [];
    afterEach(async () => {
        await Promise.all(engines.map((e) => e.dispose()));
        engines = [];
    });

    it("auto mode speaks sentence by sentence, waiting for sayState between them", async () => {
        const t = setup((s) => (s.assistant.replyMode = "auto"));
        engines.push(t.engine);
        t.engine.onEvent(chat("ce faci codai?"));
        await settle();
        expect(t.says().map((m) => m.text)).toEqual(["Salut!"]);
        expect(t.control.state.speakingId).toBe(t.says()[0]?.id);

        t.engine.onSayState(t.says()[0]?.id ?? "", "done");
        expect(t.says().map((m) => m.text)).toEqual(["Salut!", "Bine ai venit."]);
        t.engine.onSayState(t.says()[1]?.id ?? "", "done");
        expect(t.control.state.speakingId).toBeUndefined();
        expect(t.engine.snapshot()[0]?.status).toBe("done");
    });

    it("approve mode holds the draft until approved, with optional edit", async () => {
        const t = setup((s) => (s.assistant.replyMode = "approve"));
        engines.push(t.engine);
        t.engine.onEvent(chat("ce faci codai?"));
        await settle();
        const item = t.engine.snapshot()[0];
        expect(item?.status).toBe("ready");
        expect(t.says()).toHaveLength(0);

        t.engine.approve(item?.id ?? "", "Text editat de streamer.");
        expect(t.says().map((m) => m.text)).toEqual(["Text editat de streamer."]);
    });

    it("never speaks while muted, in Shop LIVE, or right after the streamer talked", async () => {
        const t = setup((s) => {
            s.assistant.replyMode = "auto";
            s.assistant.transcribe = true;
            s.assistant.quietAfterStreamerMs = 60_000;
        });
        engines.push(t.engine);
        t.control.apply("muteAssistant");
        t.engine.onEvent(chat("ce faci codai?"));
        await settle();
        expect(t.says()).toHaveLength(0);
        expect(t.codai.streamChat).not.toHaveBeenCalled();

        t.control.apply("unmuteAssistant");
        t.engine.onTranscript("1", "deci cum ziceam", true, Date.now());
        t.engine.pump();
        await settle();
        expect(t.engine.snapshot()[0]?.status).toBe("ready");
        expect(t.says()).toHaveLength(0);

        t.settings.assistant.quietAfterStreamerMs = 0;
        t.control.apply("shopModeOn");
        t.engine.pump();
        expect(t.says()).toHaveLength(0);
        t.control.apply("shopModeOff");
        t.engine.pump();
        expect(t.says()).toHaveLength(1);
    });

    it("skipCurrent cancels the utterance and moves on", async () => {
        const t = setup((s) => (s.assistant.replyMode = "auto"));
        engines.push(t.engine);
        t.engine.onEvent(chat("ce faci codai?"));
        await settle();
        const sayId = t.says()[0]?.id;
        t.engine.skipCurrent();
        expect(t.sent).toContainEqual({ type: "sayCancel", id: sayId });
        expect(t.engine.snapshot()[0]?.status).toBe("skipped");
        expect(t.control.state.speakingId).toBeUndefined();
    });

    it("reads chat aloud when AI replies are off and thanks gifts once per 5 min", () => {
        const t = setup((s) => {
            s.assistant.aiReplies = false;
            s.voice.filters.gifts = false;
        });
        engines.push(t.engine);
        t.engine.onEvent(chat("salut tuturor"));
        expect(t.says().map((m) => m.text)).toEqual(["ana zice: salut tuturor"]);
        t.engine.onSayState(t.says()[0]?.id ?? "", "done");

        const gift = (): ChatEvent => ({ ...chat("sent Rose", "ion"), kind: "gift", giftName: "Rose", giftDiamonds: 1, giftCount: 1 });
        t.engine.onEvent(gift());
        t.engine.onEvent(gift());
        expect(t.says().map((m) => m.text)).toEqual(["ana zice: salut tuturor", "Mulțumim mult, ion, pentru Rose!"]);
        t.engine.onSayState(t.says()[1]?.id ?? "", "done");
        expect(t.says()).toHaveLength(2);
        expect(t.codai.streamChat).not.toHaveBeenCalled();
    });

    it("honours the reply bucket (burst 2) and skips low-score chatter", async () => {
        const t = setup((s) => {
            s.assistant.replyMode = "approve";
            s.assistant.repliesPerMinute = 1;
        });
        engines.push(t.engine);
        t.engine.onEvent(chat("ok"));
        expect(t.engine.snapshot()).toHaveLength(0);
        for (const user of ["a", "b", "c"]) {
            t.engine.onEvent(chat(`ce faci codai, ${user}?`, user));
            await settle();
        }
        expect(t.codai.streamChat).toHaveBeenCalledTimes(2);
    });
});
