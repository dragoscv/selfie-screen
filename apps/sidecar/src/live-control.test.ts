import { CONTROL_ACTIONS, liveControlStateSchema } from "@tiksee/core";
import { describe, expect, it, vi } from "vitest";

import { LiveControl, applyControl } from "./live-control.js";

const initial = liveControlStateSchema.parse({});

describe("applyControl", () => {
    it("handles every declared action", () => {
        for (const action of CONTROL_ACTIONS) {
            expect(() => applyControl(initial, action)).not.toThrow();
        }
    });

    it("toggles flags pairwise and reports changes", () => {
        const pairs = [
            ["muteAssistant", "unmuteAssistant", "muted"],
            ["pauseReplies", "resumeReplies", "repliesPaused"],
            ["effectsOff", "effectsOn", "effectsOff"],
            ["shopModeOn", "shopModeOff", "shopMode"],
            ["petsHide", "petsShow", "petsHidden"],
        ] as const;
        for (const [on, off, key] of pairs) {
            const a = applyControl(initial, on);
            expect(a.state[key]).toBe(true);
            expect(a.changed).toBe(true);
            const again = applyControl(a.state, on);
            expect(again.changed).toBe(false);
            const b = applyControl(a.state, off);
            expect(b.state[key]).toBe(false);
            expect(b.changed).toBe(true);
        }
    });

    it("mute and Shop LIVE silence the current utterance", () => {
        expect(applyControl(initial, "muteAssistant").effects).toEqual(["silence"]);
        expect(applyControl(initial, "shopModeOn").effects).toEqual(["silence"]);
        expect(applyControl(initial, "unmuteAssistant").effects).toEqual([]);
    });

    it("skip and highlight are one-shot effects without state change", () => {
        const skip = applyControl(initial, "skipCurrent");
        expect(skip).toEqual({ state: initial, changed: false, effects: ["skipCurrent"] });
        expect(applyControl(initial, "highlight").effects).toEqual(["highlight"]);
    });
});

describe("LiveControl", () => {
    it("broadcasts only on change, including speaking id", () => {
        const onChange = vi.fn();
        const control = new LiveControl(onChange);
        control.apply("pauseReplies");
        control.apply("pauseReplies");
        control.apply("skipCurrent");
        expect(onChange).toHaveBeenCalledTimes(1);
        control.setSpeaking("u1");
        control.setSpeaking("u1");
        control.setSpeaking(undefined);
        expect(onChange).toHaveBeenCalledTimes(3);
        expect(control.state.speakingId).toBeUndefined();
    });
});
