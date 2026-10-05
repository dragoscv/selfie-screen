import { assistantSchema, nextEventId, voiceSchema, type ChatEvent, type ChatKind } from "@tiksee/core";
import { describe, expect, it, vi } from "vitest";

import { Coach, COACH_MIN_GAP_MS } from "./coach.js";
import { FactCollector, parseFacts } from "./facts.js";
import { draftReply, systemPrompt, userPrompt } from "./responder.js";
import { adjustmentFor } from "./s1.js";
import { passesReadFilters, readAloudLine, speakable, thanksLine } from "./templates.js";
import { TranscriptWindow } from "./transcript.js";

function ev(kind: ChatKind, text: string, at = 0, extra: Partial<ChatEvent> = {}): ChatEvent {
    return { id: nextEventId(), kind, user: { id: "1", uniqueId: "ana", nickname: "Ana ❤️" }, text, at, streamId: "main", ...extra };
}

describe("templates", () => {
    it("strips emoji and links from spoken text", () => {
        expect(speakable("Salut ❤️❤️ vezi https://x.y/z acum 🎁")).toBe("Salut vezi acum");
    });

    it("builds Romanian thanks and read-aloud lines", () => {
        expect(thanksLine(ev("gift", "sent Rose", 0, { giftName: "Rose", giftCount: 3 }))).toBe("Mulțumim mult, Ana, pentru cele 3 Rose!");
        const voice = voiceSchema.parse({});
        expect(readAloudLine(ev("chat", "ce faci?"), voice)).toBe("Ana zice: ce faci?");
        expect(readAloudLine(ev("chat", "ce faci?"), { ...voice, readUsernames: false })).toBe("ce faci?");
        expect(readAloudLine(ev("follow", "followed"), voice)).toBe("Ana te urmărește acum");
    });

    it("applies read filters and the minimum gift value", () => {
        const voice = voiceSchema.parse({ minGiftValueToRead: 10 });
        expect(passesReadFilters(ev("join", "joined"), voice)).toBe(false);
        expect(passesReadFilters(ev("chat", "hi"), voice)).toBe(true);
        expect(passesReadFilters(ev("gift", "g", 0, { giftDiamonds: 1, giftCount: 5 }), voice)).toBe(false);
        expect(passesReadFilters(ev("gift", "g", 0, { giftDiamonds: 5, giftCount: 2 }), voice)).toBe(true);
    });
});

describe("TranscriptWindow", () => {
    it("keeps the last minute of finals plus the live partial", () => {
        const window = new TranscriptWindow(60_000);
        window.push("1", "bună seara", true, 0);
        window.push("2", "azi jucăm", false, 1_000);
        window.push("2", "azi jucăm Minecraft", true, 2_000);
        window.push("3", "și apoi", false, 3_000);
        expect(window.text(3_000)).toBe("bună seara azi jucăm Minecraft și apoi");
        expect(window.lastAt).toBe(3_000);
        window.push("4", "gata", true, 70_000);
        expect(window.text(70_000)).toBe("gata");
    });
});

describe("responder", () => {
    const assistant = assistantSchema.parse({ aboutMe: "Joc Minecraft" });

    it("keeps the system prompt stable and puts per-request data in the user part", () => {
        expect(systemPrompt(assistant)).toBe(systemPrompt(assistant));
        expect(systemPrompt(assistant)).toContain("Codai");
        expect(systemPrompt(assistant)).toContain("Joc Minecraft");
        const user = userPrompt({ nickname: "Ana", uniqueId: "ana", message: "ce faci?", reasons: ["question"], visits: 3, facts: ["e din Cluj"], transcript: "salut" });
        expect(user).toContain("ce faci?");
        expect(user).toContain("e din Cluj");
        expect(user).toContain("Vizite anterioare: 2");
    });

    function fakeClient(sentences: string[]) {
        return {
            streamChat: vi.fn(async (request: { onSentence?: (s: string, i: number) => void; signal?: AbortSignal }) => {
                for (const [i, s] of sentences.entries()) {
                    if (request.signal?.aborted) return { ok: false as const, error: { kind: "aborted" as const, message: "aborted" } };
                    request.onSentence?.(s, i);
                }
                return { ok: true as const, value: { text: sentences.join(" "), sentences, firstSentenceMs: 1, totalMs: 2 } };
            }),
        };
    }
    const context = { nickname: "Ana", uniqueId: "ana", message: "hi", reasons: [], transcript: "" };

    it("streams at most two moderated sentences", async () => {
        const spoken: string[] = [];
        const result = await draftReply(fakeClient(["Salut, Ana! 👋", "Mă bucur.", "A treia."]), {
            model: "codai-fast",
            assistant,
            context,
            blocked: null,
            signal: new AbortController().signal,
            callbacks: { onSentence: (s) => spoken.push(s) },
        });
        expect(spoken).toEqual(["Salut, Ana!", "Mă bucur."]);
        expect(result).toEqual({ ok: true, value: "Salut, Ana! Mă bucur." });
    });

    it("rejects a draft containing a blocked word", async () => {
        const { compileWordList } = await import("@tiksee/core");
        const result = await draftReply(fakeClient(["Ești prost."]), {
            model: "m",
            assistant,
            context,
            blocked: compileWordList(["prost"]),
            signal: new AbortController().signal,
            callbacks: { onSentence: () => undefined },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe("blocked");
    });
});

describe("System One adjustments", () => {
    it("only trusts confident answers", () => {
        const confident = adjustmentFor(
            {
                is_question: { type: "noul", noul: 0.92 },
                needs_reply: { type: "noul", noul: 0.8 },
                intent: { type: "choice", choice: "question", confidence: 0.85 },
                emotion: { type: "choice", choice: "sad", confidence: 0.75 },
            },
            false,
        );
        expect(confident.delta).toBe(5.5);
        expect(confident.reasons).toEqual(["question", "s1:needs-reply", "s1:question", "mood:sad"]);

        const unsure = adjustmentFor(
            { is_question: { type: "noul", noul: 0.6 }, intent: { type: "choice", choice: "spam", confidence: 0.5 } },
            false,
        );
        expect(unsure).toEqual({ delta: 0, reasons: [], skip: false });
        expect(adjustmentFor({ intent: { type: "choice", choice: "spam", confidence: 0.9 } }, false).skip).toBe(true);
        expect(adjustmentFor({ is_question: { type: "noul", noul: 0.95 } }, true).delta).toBe(0);
    });
});

describe("facts", () => {
    it("parses only allowed viewers from a JSON reply", () => {
        const facts = parseFacts('Sigur: {"ana": ["locuiește în Cluj", 3], "intrus": ["x y z"]}', new Set(["ana"]));
        expect([...facts]).toEqual([["ana", ["locuiește în Cluj"]]]);
        expect(parseFacts("nimic", new Set(["ana"])).size).toBe(0);
    });

    it("batches messages into one call and stores the results", async () => {
        const store = vi.fn();
        const complete = vi.fn(async () => ({ ok: true as const, value: '{"ana":["are un câine"]}' }));
        const collector = new FactCollector({ client: { complete }, model: () => "codai-fast", store });
        collector.add({ uniqueId: "ana", nickname: "Ana", text: "am un câine pe nume Rex" });
        collector.add({ uniqueId: "ion", nickname: "Ion", text: "salut tuturor de aici" });
        expect(await collector.flush()).toBe(1);
        expect(complete).toHaveBeenCalledOnce();
        expect(store).toHaveBeenCalledWith("ana", ["are un câine"]);
        collector.dispose();
    });
});

describe("Coach", () => {
    it("suggests unanswered questions, pending thanks, quiet chat — rate limited", () => {
        const emitted: string[] = [];
        const coach = new Coach((s) => emitted.push(s.kind));
        coach.start(0);
        coach.onEvent(ev("chat", "ce joc e?", 0), true);
        coach.onEvent(ev("gift", "g", 1_000), false);
        expect(coach.tick(30_000)?.kind).toBe("thanks");
        expect(coach.tick(40_000)).toBeNull();
        expect(coach.tick(30_000 + COACH_MIN_GAP_MS + 10_000)?.kind).toBe("unanswered");
        expect(coach.tick(200_000)?.kind).toBe("quiet");
        expect(coach.tick(400_000)).toBeNull();
        expect(emitted).toEqual(["thanks", "unanswered", "quiet"]);
    });

    it("clears a viewer's open items when answered", () => {
        const coach = new Coach(() => undefined);
        coach.start(0);
        coach.onEvent(ev("chat", "ce faci?", 0), true);
        coach.answered("ana");
        coach.onEvent(ev("chat", "salut", 50_000), false);
        expect(coach.tick(70_000)).toBeNull();
    });

    it("detects a chat spike against the rolling average", () => {
        const coach = new Coach(() => undefined);
        coach.start(0);
        let t = 0;
        for (let minute = 0; minute < 4; minute += 1) {
            for (let i = 0; i < 3; i += 1) coach.onEvent(ev("chat", "hi", (t += 15_000)), false);
            t = (minute + 1) * 60_000;
        }
        for (let i = 0; i < 30; i += 1) coach.onEvent(ev("chat", "wow", t + i * 1000), false);
        expect(coach.tick(t + 31_000)?.kind).toBe("spike");
    });
});
