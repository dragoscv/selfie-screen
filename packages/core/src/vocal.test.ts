import { describe, expect, it } from "vitest";

import { defaultSettings } from "./settings.js";
import {
    BUILTIN_SECTION_PRESETS,
    VOCAL_SECTIONS,
    applySection,
    noteName,
    parseVocalImport,
    sectionValues,
    vocalParamsSchema,
    vocalSchema,
} from "./vocal.js";

describe("vocal settings", () => {
    it("defaults match the Rust engine defaults", () => {
        const v = defaultSettings().vocal;
        expect(v.enabled).toBe(false);
        expect(v.params.tune.retuneMs).toBe(40);
        expect(v.params.chain.eq).toHaveLength(5);
        expect(v.params.harmony.voices).toHaveLength(3);
    });

    it("names notes", () => {
        expect(noteName(69)).toBe("A4");
        expect(noteName(60)).toBe("C4");
    });

    it("section presets touch only their own slice", () => {
        const base = vocalParamsSchema.parse({ tune: { key: 9, scale: "minor", retuneMs: 40 }, chain: { reverbMix: 0.15, compRatio: 3 } });
        const fx = applySection(base, "fx", { reverbMix: 0.5, compRatio: 9 });
        expect(fx.chain.reverbMix).toBe(0.5);
        expect(fx.chain.compRatio).toBe(3); // voice field ignored by an fx preset
        const tune = applySection(base, "tune", { retuneMs: 0, key: 2 });
        expect(tune.tune.retuneMs).toBe(0);
        expect(tune.tune.key).toBe(9); // key stays with the song
    });

    it("a saved section round-trips", () => {
        const base = vocalParamsSchema.parse({ chain: { gateThresholdDb: -42, notchHz: [494, 0, 0, 0] } });
        for (const s of VOCAL_SECTIONS) {
            const values = sectionValues(base, s);
            expect(applySection(vocalParamsSchema.parse({}), s, values)).toMatchObject({ ...sectionValuesOwner(base, s) });
        }
    });

    it("every built-in preset applies without throwing", () => {
        const base = vocalParamsSchema.parse({});
        for (const s of VOCAL_SECTIONS) for (const v of Object.values(BUILTIN_SECTION_PRESETS[s])) expect(() => applySection(base, s, v)).not.toThrow();
    });

    it("imports a full export and a preset file, rejects garbage", () => {
        const settings = vocalSchema.parse({ presets: [{ id: "p1", name: "Mine", section: "fx", values: { reverbMix: 0.3 } }] });
        const full = parseVocalImport(JSON.stringify({ kind: "tiksee-vocal", version: 1, exportedAt: 1, settings }));
        expect(full.settings?.presets[0]?.name).toBe("Mine");
        const file = parseVocalImport(JSON.stringify({ kind: "tiksee-vocal-preset", version: 1, presets: settings.presets }));
        expect(file.settings).toBeUndefined();
        expect(file.presets).toHaveLength(1);
        expect(() => parseVocalImport("{}")).toThrow();
        expect(() => parseVocalImport("nope")).toThrow();
    });
});

/** Which top-level part of the params a section owns (for the round-trip check). */
function sectionValuesOwner(p: ReturnType<typeof vocalParamsSchema.parse>, s: (typeof VOCAL_SECTIONS)[number]) {
    if (s === "tune") return { tune: { retuneMs: p.tune.retuneMs } };
    if (s === "voice") return { chain: { gateThresholdDb: p.chain.gateThresholdDb, notchHz: p.chain.notchHz } };
    if (s === "fx") return { chain: { reverbMix: p.chain.reverbMix } };
    return { harmony: { double: p.harmony.double } };
}
