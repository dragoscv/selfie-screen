import { describe, expect, it } from "vitest";

import { parseClientMessage, parseServerMessage } from "./protocol.js";
import { defaultSettings, parseSettings } from "./settings.js";
import { SIGNAL_IDS, defaultRules, ruleSchema, signalFamily, type Rule } from "./vision.js";

describe("vision contract", () => {
    it("signal ids are unique and every one has a family", () => {
        expect(new Set(SIGNAL_IDS).size).toBe(SIGNAL_IDS.length);
        for (const id of SIGNAL_IDS) expect(signalFamily(id)).toBeTypeOf("string");
        expect(signalFamily("wink_left")).toBe("face");
        expect(signalFamily("heart")).toBe("twoHands");
        expect(signalFamily("dog_enter")).toBe("presence");
    });

    it("default rules validate and have unique ids", () => {
        const rules = defaultRules();
        expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
        for (const r of rules) expect(ruleSchema.safeParse(r).success).toBe(true);
    });

    it("sensitive defaults require arming", () => {
        const byId = new Map(defaultRules().map((r) => [r.id, r]));
        expect(byId.get("timeout-mute")?.requiresArm).toBe(true);
        expect(byId.get("swipe-scene")?.requiresArm).toBe(true);
        expect(byId.get("wink-hearts")?.requiresArm).toBe(false);
    });

    it("nested if/else, repeat and parallel round-trip through the schema", () => {
        const rule: Rule = {
            id: "nested",
            name: "nested",
            enabled: true,
            requiresArm: false,
            mode: "queued",
            cooldownMs: 0,
            triggers: [{ type: "signal", signal: "smile", on: "hold", holdMs: 800, minConfidence: 0.6, who: "owner" }],
            when: {
                type: "all",
                of: [
                    { type: "compare", var: "live.connected", op: "eq", value: true },
                    { type: "not", of: { type: "signalActive", signal: "talking", who: "owner" } },
                ],
            },
            actions: [
                {
                    type: "if",
                    cond: { type: "any", of: [{ type: "compare", var: "vision.energy", op: "gt", value: 0.7 }] },
                    then: [{ type: "repeat", count: 2, do: [{ type: "effect", effect: "confetti" }, { type: "wait", ms: 200 }] }],
                    else: [{ type: "parallel", branches: [[{ type: "pet", reaction: "dance" }], [{ type: "camera", action: "af" }]] }],
                },
            ],
            ui: { graph: { t0: { x: 0, y: 0 } } },
        };
        expect(ruleSchema.parse(rule)).toEqual(rule);
    });

    it("settings default to the shipped rules and repair a broken vision section", () => {
        expect(defaultSettings().vision.rules.length).toBe(defaultRules().length);
        const repaired = parseSettings({ vision: { maxPeople: 99 } });
        expect(repaired.vision.maxPeople).toBe(2);
        expect(repaired.studio.virtualCamera).toBe(true);
        expect(repaired.studio.monitor.zebraLevel).toBe(95);
    });

    it("wire messages validate", () => {
        const msg = {
            type: "visionSignals",
            events: [
                {
                    signal: "wink_left",
                    phase: "pulse",
                    at: 1,
                    confidence: 0.9,
                    subject: { kind: "person", track: 0, owner: true },
                },
            ],
        };
        expect(parseClientMessage(JSON.stringify(msg))?.type).toBe("visionSignals");
        expect(parseServerMessage(JSON.stringify({ type: "ruleAction", ruleId: "x", action: { type: "camera", action: "af" } }))?.type).toBe(
            "ruleAction",
        );
        expect(parseClientMessage(JSON.stringify({ type: "visionSignals", events: [{ signal: "nope" }] }))).toBeNull();
    });
});
