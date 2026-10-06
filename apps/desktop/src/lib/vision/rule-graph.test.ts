import { defaultRules, ruleSchema, type Rule } from "@tiksee/core";
import { describe, expect, it } from "vitest";

import { countActions, moveItem, rulesBySignal, signalsUsed, uniqueRuleId } from "./catalog.js";
import { GATE_ID, connect, graphToRule, removeNodes, ruleToGraph } from "./rule-graph.js";

const deep: Rule = ruleSchema.parse({
    id: "deep",
    name: "Deep",
    triggers: [
        { type: "signal", signal: "fist", on: "hold", holdMs: 800 },
        { type: "chat", contains: "!boom" },
        { type: "timer", everyMs: 60_000 },
    ],
    when: {
        type: "all",
        of: [
            { type: "compare", var: "live.viewers", op: "gt", value: 5 },
            { type: "not", of: { type: "signalActive", signal: "talking", who: "owner" } },
            { type: "any", of: [{ type: "compare", var: "vision.armed", op: "eq", value: true }] },
        ],
    },
    actions: [
        {
            type: "if",
            cond: { type: "compare", var: "var.a", op: "lt", value: 3 },
            then: [
                { type: "set", var: "var.a", op: "inc", value: 1 },
                {
                    type: "repeat",
                    count: 3,
                    do: [
                        { type: "effect", effect: "confetti" },
                        { type: "wait", ms: 200 },
                        {
                            type: "if",
                            cond: { type: "signalActive", signal: "smile", who: "anyone" },
                            then: [{ type: "pet", reaction: "dance" }],
                            else: [],
                        },
                    ],
                },
            ],
            else: [
                {
                    type: "parallel",
                    branches: [
                        [{ type: "speak", text: "Gata!" }],
                        [{ type: "vmuiFlash", color: "red" }, { type: "stop" }],
                        [],
                    ],
                },
            ],
        },
        { type: "camera", action: "photo", holdMs: 100 },
        { type: "stop" },
    ],
});

/** Positions are written for every node, so compare the tree only. */
const tree = (r: Rule) => ({ ...r, ui: { graph: {} } });

describe("ruleToGraph / graphToRule", () => {
    it.each(defaultRules().map((r) => [r.id, r] as const))("round-trips default rule %s", (_id, rule) => {
        const { rule: back, orphans } = graphToRule(ruleToGraph(rule), rule);
        expect(orphans).toEqual([]);
        expect(tree(back)).toEqual(tree(rule));
        expect(ruleSchema.safeParse(back).success).toBe(true);
    });

    it("round-trips a deeply nested rule", () => {
        const graph = ruleToGraph(deep);
        expect(graph.nodes.filter((n) => n.type === "action")).toHaveLength(countActions(deep.actions));
        const { rule: back, orphans } = graphToRule(graph, deep);
        expect(orphans).toEqual([]);
        expect(tree(back)).toEqual(tree(deep));
    });

    it("keys nodes by tree path and keeps saved positions", () => {
        const withPos: Rule = { ...deep, ui: { graph: { "a0.then.1.do.2": { x: 40, y: 90 }, t1: { x: 3, y: 4 } } } };
        const graph = ruleToGraph(withPos);
        const ids = graph.nodes.map((n) => n.id);
        expect(ids).toEqual(
            expect.arrayContaining(["t0", "t1", "t2", GATE_ID, "a0", "a0.then.0", "a0.then.1.do.2.then.0", "a0.else.0.b1.1", "a2"]),
        );
        expect(graph.nodes.find((n) => n.id === "a0.then.1.do.2")?.position).toEqual({ x: 40, y: 90 });
        const back = graphToRule(graph, withPos).rule;
        expect(back.ui.graph["a0.then.1.do.2"]).toEqual({ x: 40, y: 90 });
        expect(back.ui.graph.t1).toEqual({ x: 3, y: 4 });
    });

    it("drops the guard when the gate has no condition", () => {
        const graph = ruleToGraph(deep);
        const gate = graph.nodes.find((n) => n.id === GATE_ID);
        if (gate?.data.kind === "gate") gate.data = { kind: "gate", cond: undefined };
        expect(graphToRule(graph, deep).rule.when).toBeUndefined();
    });

    it("rebuilds from edges: deleting a node detaches its successors as orphans", () => {
        const graph = removeNodes(ruleToGraph(deep), new Set(["a1"]));
        const { rule, orphans } = graphToRule(graph, deep);
        expect(rule.actions).toHaveLength(1);
        expect(orphans).toEqual(["a2"]);
    });

    it("connect keeps one edge per handle and one parent per action", () => {
        const g0 = removeNodes(ruleToGraph(deep), new Set(["a1"]));
        // Reattach a2 after a0 (a0.next was freed by the delete).
        const g1 = connect(g0, "a0", "next", "a2");
        const r1 = graphToRule(g1, deep).rule;
        expect(r1.actions.map((a) => a.type)).toEqual(["if", "stop"]);
        // Moving a2 under the if's else branch steals it from a0.next.
        const g2 = connect(g1, "a0", "else", "a2");
        const r2 = graphToRule(g2, deep).rule;
        expect(r2.actions.map((a) => a.type)).toEqual(["if"]);
        const first = r2.actions[0];
        expect(first?.type === "if" ? first.else.map((a) => a.type) : []).toEqual(["stop"]);
        // Triggers may only feed the gate.
        expect(connect(g2, "t0", "next", "a0")).toBe(g2);
    });

    it("graph-added nodes with arbitrary ids become part of the tree", () => {
        const base = defaultRules()[0];
        if (!base) throw new Error("no default rules");
        const g = ruleToGraph(base);
        g.nodes.push({ id: "new-1", type: "action", position: { x: 1, y: 2 }, data: { kind: "action", action: { type: "wait", ms: 500 } } });
        const linked = connect(g, "a0", "next", "new-1");
        const { rule } = graphToRule(linked, base);
        expect(rule.actions.map((a) => a.type)).toEqual(["effect", "wait"]);
        expect(rule.ui.graph.a1).toEqual({ x: 1, y: 2 });
    });
});

describe("catalog helpers", () => {
    it("finds signals in triggers, guards and nested conditions", () => {
        expect([...signalsUsed(deep)].sort()).toEqual(["fist", "smile", "talking"]);
        const map = rulesBySignal(defaultRules());
        expect(map.get("wink_left")?.map((r) => r.id)).toEqual(["wink-hearts"]);
    });

    it("makes unique slug ids", () => {
        expect(uniqueRuleId("Wink → hearts", ["wink-hearts"])).toBe("wink-hearts-2");
        expect(uniqueRuleId("Față zâmbitoare", [])).toBe("fata-zambitoare");
    });

    it("moves list items with clamping", () => {
        expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
        expect(moveItem([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
    });
});
