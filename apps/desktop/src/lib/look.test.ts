import { studioSchema } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import en from "../i18n/en.json";
import studioEn from "../i18n/studio.en.json";
import { LOOK_CONTROLS, LOOK_RESET, lookIsDefault } from "./look.js";

describe("look controls", () => {
    const defaults = studioSchema.parse({});

    it("defaults to an untouched camera", () => {
        expect(lookIsDefault(defaults)).toBe(true);
    });

    it("ranges match the settings schema so a slider can never write an invalid value", () => {
        for (const c of LOOK_CONTROLS) {
            expect(studioSchema.safeParse({ [c.key]: c.min }).success, `${c.key} min`).toBe(true);
            expect(studioSchema.safeParse({ [c.key]: c.max }).success, `${c.key} max`).toBe(true);
            expect(studioSchema.safeParse({ [c.key]: c.max + c.step * 10 }).success, `${c.key} above max`).toBe(false);
        }
    });

    it("reset covers every control and flags a changed grade", () => {
        expect(Object.keys(LOOK_RESET).sort()).toEqual(LOOK_CONTROLS.map((c) => c.key).sort());
        expect(lookIsDefault({ ...defaults, contrast: 0.2 })).toBe(false);
        const changed = { ...defaults, contrast: 0.2 };
        expect(lookIsDefault({ ...changed, ...LOOK_RESET })).toBe(true);
    });

    it("every control has a label in Settings and in the Studio", () => {
        for (const c of LOOK_CONTROLS) {
            expect(en.settings.studio.look[c.key], c.key).toBeTruthy();
            expect(studioEn.controls.look[c.key], c.key).toBeTruthy();
        }
    });
});
