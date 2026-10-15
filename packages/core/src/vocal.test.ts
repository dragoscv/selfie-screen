import { describe, expect, it } from "vitest";

import { defaultSettings } from "./settings.js";
import { applyVocalPreset, noteName, vocalParamsSchema } from "./vocal.js";

describe("vocal settings", () => {
    it("defaults match the Rust engine defaults", () => {
        const v = defaultSettings().vocal;
        expect(v.enabled).toBe(false);
        expect(v.params.tune.retuneMs).toBe(40);
        expect(v.params.chain.eq).toHaveLength(5);
        expect(v.params.harmony.voices).toHaveLength(3);
    });

    it("presets keep key and scale", () => {
        const base = vocalParamsSchema.parse({ tune: { key: 9, scale: "minor" } });
        const hard = applyVocalPreset(base, "hardTune");
        expect(hard.tune.key).toBe(9);
        expect(hard.tune.scale).toBe("minor");
        expect(hard.tune.retuneMs).toBe(0);
    });

    it("names notes", () => {
        expect(noteName(69)).toBe("A4");
        expect(noteName(60)).toBe("C4");
    });
});
