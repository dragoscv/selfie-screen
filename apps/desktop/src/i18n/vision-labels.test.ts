import {
    AR_EFFECTS,
    CAMERA_ACTIONS,
    COMPARE_OPS,
    CONTROL_ACTIONS,
    PET_REACTIONS,
    PROFILE_KINDS,
    RULE_MODES,
    RULE_VARS,
    SIGNAL_FAMILIES,
    SIGNAL_IDS,
    STUDIO_ACTIONS,
    TRIGGER_KINDS,
} from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { ACTION_EMOJI, varKey } from "../lib/vision/catalog.js";
import visionEn from "./vision.en.json";
import visionRo from "./vision.ro.json";

type Tree = { [key: string]: string | Tree };

const GROUPS: Record<string, readonly string[]> = {
    signals: SIGNAL_IDS,
    families: SIGNAL_FAMILIES,
    actionTypes: Object.keys(ACTION_EMOJI),
    triggerTypes: TRIGGER_KINDS,
    controlActions: CONTROL_ACTIONS,
    cameraActions: CAMERA_ACTIONS,
    studioActions: STUDIO_ACTIONS,
    effects: AR_EFFECTS,
    petReactions: PET_REACTIONS,
    ops: COMPARE_OPS,
    modes: RULE_MODES,
    kinds: PROFILE_KINDS,
    vars: RULE_VARS.map(varKey),
    who: ["owner", "anyPerson", "anyDog", "anyone", "profile"],
    triggerOn: ["start", "end", "hold"],
    arOps: ["show", "hide", "toggle"],
    setOps: ["set", "inc", "dec"],
};

function missing(bundle: Tree): string[] {
    return Object.entries(GROUPS).flatMap(([group, ids]) => {
        const node = bundle[group];
        return ids.filter((id) => typeof node !== "object" || typeof node[id] !== "string" || node[id].trim() === "").map((id) => `${group}.${id}`);
    });
}

describe("vision labels", () => {
    it("every signal id, action type and enum value is labelled in en and ro", () => {
        expect({ en: missing(visionEn as Tree), ro: missing(visionRo as Tree) }).toEqual({ en: [], ro: [] });
    });

    it("Romanian uses comma-below diacritics, never cedilla forms", () => {
        const text = JSON.stringify(visionRo);
        expect(text).not.toMatch(/[\u015E\u015F\u0162\u0163]/);
    });
});
