import { describe, expect, it } from "vitest";

import { defaultSettings, parseSettings, settingsSchema } from "./settings.js";

describe("settings", () => {
    it("produces a fully populated default tree", () => {
        const s = defaultSettings();
        expect(s.version).toBe(1);
        expect(s.appearance.mode).toBe("dark");
        expect(s.appearance.accent).toBe("cyan");
        expect(s.appearance.surface).toBe("mica");
        expect(s.voice.voice).toBe("marin");
        expect(s.assistant.personaName).toBe("Aria");
    });

    it("keeps parity with the Android defaults", () => {
        const s = defaultSettings();
        // Voice block
        expect(s.voice.enabled).toBe(true);
        expect(s.voice.speed).toBe(1);
        expect(s.voice.pitch).toBe(1);
        expect(s.voice.volume).toBe(1);
        expect(s.voice.readUsernames).toBe(true);
        expect(s.voice.language).toBe("auto");
        expect(s.voice.audioOutput).toBe("auto");
        // Read filters: joins and likes off, the rest on
        expect(s.voice.filters).toEqual({
            chat: true,
            gifts: true,
            follows: true,
            joins: false,
            likes: false,
            shares: true,
        });
        // Assistant
        expect(s.assistant.aiReplies).toBe(false);
        expect(s.assistant.aiInitiates).toBe(false);
        expect(s.assistant.idleChatterSeconds).toBe(120);
        expect(s.assistant.personality).toBe("friendly, witty, concise");
        // Safety
        expect(s.safety.moderation).toBe(true);
        expect(s.safety.maxQueue).toBe(8);
        expect(s.safety.skipDuplicates).toBe(true);
        // Display aggregation
        expect(s.display.collapseJoinsPanel).toBe(true);
        expect(s.display.collapseLikesPanel).toBe(true);
        expect(s.display.mergeSameUser).toBe(true);
        // Overlay
        expect(s.overlay.opacity).toBeCloseTo(0.82);
        expect(s.overlay.blur).toBeCloseTo(0.35);
        expect(s.overlay.clickThrough).toBe(false);
        // Connection defaults inherited from the Android encrypted store
        expect(s.connection.azureEndpoint).toBe("codai-foundry2.openai.azure.com");
        expect(s.connection.ttsDeployment).toBe("selfie-tts");
        expect(s.connection.aiDeployment).toBe("selfie-ai");
    });

    it("round-trips a full settings object", () => {
        const s = defaultSettings();
        expect(settingsSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
    });

    it("repairs a corrupt section instead of throwing", () => {
        const parsed = parseSettings({
            version: 1,
            appearance: { mode: "not-a-mode", accent: "violet" },
            voice: { speed: 1.25 },
        });
        // The bad section falls back wholesale...
        expect(parsed.appearance.mode).toBe("dark");
        // ...while a valid sibling section is preserved.
        expect(parsed.voice.speed).toBe(1.25);
    });

    it("falls back to defaults for non-object input", () => {
        expect(parseSettings(null)).toEqual(defaultSettings());
        expect(parseSettings("nonsense")).toEqual(defaultSettings());
        expect(parseSettings(42)).toEqual(defaultSettings());
    });

    it("ignores unknown top-level keys", () => {
        const parsed = parseSettings({ ...defaultSettings(), somethingNew: { a: 1 } });
        expect(parsed).toEqual(defaultSettings());
    });

    it("clamps out-of-range values by rejecting them", () => {
        const parsed = parseSettings({ voice: { speed: 99 } });
        expect(parsed.voice.speed).toBe(1);
    });
});
