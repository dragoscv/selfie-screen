import { describe, expect, it, vi } from "vitest";

import type { CodaiClient } from "../codai/client.js";
import { detectLanguage, letterCount } from "./detect.js";
import { Translator, parseTranslations } from "./translator.js";

describe("detectLanguage", () => {
    it("keeps Romanian lines, with or without diacritics", () => {
        expect(detectLanguage("Bună seara tuturor!")).toEqual({ lang: "ro", foreign: false });
        expect(detectLanguage("ce faci, esti bine azi?").foreign).toBe(false);
        expect(detectLanguage("multumesc pentru live").foreign).toBe(false);
        expect(detectLanguage("salut din Brasov").foreign).toBe(false);
    });

    it("flags common foreign languages by stopwords", () => {
        expect(detectLanguage("hello how are you today")).toEqual({ lang: "en", foreign: true });
        expect(detectLanguage("I love your stream")).toMatchObject({ lang: "en", foreign: true });
        expect(detectLanguage("hola como estas")).toMatchObject({ lang: "es", foreign: true });
        expect(detectLanguage("ciao bella, sei molto brava")).toMatchObject({ lang: "it", foreign: true });
        expect(detectLanguage("hallo, wie geht es dir")).toMatchObject({ lang: "de", foreign: true });
    });

    it("flags non-Latin scripts immediately", () => {
        expect(detectLanguage("привет как дела")).toEqual({ lang: "ru", foreign: true });
        expect(detectLanguage("مرحبا كيف حالك")).toEqual({ lang: "ar", foreign: true });
        expect(detectLanguage("こんにちは元気")).toMatchObject({ foreign: true });
    });

    it("does not guess on short, emoji-only or unknown lines", () => {
        expect(detectLanguage("ok 😂😂")).toEqual({ lang: "und", foreign: false });
        expect(detectLanguage("hahahahaha")).toEqual({ lang: "und", foreign: false });
        expect(detectLanguage("@someone_long_handle")).toEqual({ lang: "und", foreign: false });
        expect(letterCount("a1b2 😀")).toBe(2);
    });
});

describe("parseTranslations", () => {
    it("reads the JSON object and keeps only known ids", () => {
        const parsed = parseTranslations('Sure: {"m0": "Salut", "m9": "x", "m1": 3}', new Set(["m0", "m1"]));
        expect([...parsed]).toEqual([["m0", "Salut"]]);
    });

    it("returns nothing for garbage", () => {
        expect(parseTranslations("no json here", new Set(["m0"])).size).toBe(0);
        expect(parseTranslations("{broken", new Set(["m0"])).size).toBe(0);
    });
});

type Complete = Pick<CodaiClient, "complete">;

describe("Translator", () => {
    function setup(reply: Awaited<ReturnType<CodaiClient["complete"]>>) {
        const complete = vi.fn(async () => reply);
        const emitted: Array<[string, string, string]> = [];
        const errors: string[] = [];
        const translator = new Translator({
            client: { complete } as Complete,
            model: () => "codai-fast",
            emit: (id, lang, text) => emitted.push([id, lang, text]),
            onError: (m) => errors.push(m),
        });
        translator.enabled = true;
        return { translator, complete, emitted, errors };
    }

    it("skips Romanian, batches foreign lines into one call and caches results", async () => {
        const t = setup({ ok: true, value: '{"m0": "Salut, ce mai faci?", "m1": "Te iubesc"}' });
        expect(t.translator.offer({ eventId: "r", text: "salut, ce faci azi?" })).toBe(false);
        expect(t.translator.offer({ eventId: "a", text: "hello how are you" })).toBe(true);
        expect(t.translator.offer({ eventId: "b", text: "I love you so much" })).toBe(true);
        expect(await t.translator.flush()).toBe(2);
        expect(t.complete).toHaveBeenCalledTimes(1);
        expect(t.emitted).toEqual([
            ["a", "en", "Salut, ce mai faci?"],
            ["b", "en", "Te iubesc"],
        ]);

        // Same text again: served from cache, no new call.
        t.translator.offer({ eventId: "c", text: "Hello  how are YOU" });
        expect(t.emitted.at(-1)).toEqual(["c", "en", "Salut, ce mai faci?"]);
        expect(await t.translator.flush()).toBe(0);
        expect(t.complete).toHaveBeenCalledTimes(1);
        t.translator.dispose();
    });

    it("degrades to a silent no-op when codai fails or is disabled", async () => {
        const t = setup({ ok: false, error: { kind: "timeout", message: "slow" } });
        t.translator.offer({ eventId: "a", text: "hello how are you" });
        expect(await t.translator.flush()).toBe(0);
        expect(t.emitted).toEqual([]);
        expect(t.errors[0]).toContain("timeout");

        t.translator.enabled = false;
        expect(t.translator.offer({ eventId: "b", text: "hello how are you" })).toBe(false);
        t.translator.dispose();
    });
});
