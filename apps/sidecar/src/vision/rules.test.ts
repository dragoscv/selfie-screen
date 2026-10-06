import type { ChatEvent, Rule, RuleAction, RuleFired, RuleVar, SignalEvent, SignalId, Trigger } from "@tiksee/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_STEPS, RulesEngine, type ActionSink } from "./rules.js";

type Call = [string, unknown];

function harness(vars: Partial<Record<RuleVar, number | boolean>> = {}) {
    const calls: Call[] = [];
    const fired: RuleFired[] = [];
    const sink: ActionSink = {
        control: (a) => void calls.push(["control", a]),
        speak: (t) => void calls.push(["speak", t]),
        vmuiFlash: (c) => void calls.push(["vmuiFlash", c]),
        vmuiScene: (s) => void calls.push(["vmuiScene", s]),
        highlight: (l) => void calls.push(["highlight", l]),
        notify: (t) => void calls.push(["notify", t]),
        studio: (a) => void calls.push(["studio", a]),
    };
    const engine = new RulesEngine({ sink, vars: (n) => vars[n], onFired: (f) => fired.push(f) });
    return { engine, calls, fired, vars };
}

function rule(id: string, triggers: Trigger[], actions: RuleAction[], extra: Partial<Rule> = {}): Rule {
    return { id, name: id, enabled: true, requiresArm: false, mode: "single", cooldownMs: 0, triggers, actions, ui: { graph: {} }, ...extra };
}

function sig(signal: SignalId, extra: Partial<Extract<Trigger, { type: "signal" }>> = {}): Trigger {
    return { type: "signal", signal, on: "start", holdMs: 0, minConfidence: 0.6, who: "owner", ...extra };
}

function ev(signal: SignalId, phase: SignalEvent["phase"], extra: Partial<SignalEvent> = {}): SignalEvent {
    return { signal, phase, at: Date.now(), confidence: 0.9, subject: { kind: "person", track: 0, owner: true }, ...extra };
}

function chat(kind: ChatEvent["kind"], extra: Partial<ChatEvent> = {}): ChatEvent {
    return { id: "e1", kind, user: { id: "u", uniqueId: "u", nickname: "U" }, text: "salut", at: Date.now(), streamId: "main", ...extra };
}

const speak = (text = "hi"): RuleAction => ({ type: "speak", text });
const on = { enabled: true, armWindowMs: 5000 };

describe("RulesEngine", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /* triggers */

    it("fires a signal start trigger", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()])], on);
        h.engine.onSignals([ev("smile", "start")]);
        await vi.runAllTimersAsync();
        expect(h.calls).toEqual([["speak", "hi"]]);
        expect(h.fired[0]).toMatchObject({ ruleId: "r", trigger: "signal:smile:start", trace: ["speak"] });
    });

    it("treats a pulse as a start", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("wink_left")], [speak()])], on);
        h.engine.onSignals([ev("wink_left", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
    });

    it("fires an end trigger only on end, with the duration", async () => {
        const h = harness();
        h.engine.setRules(
            [rule("r", [sig("smile", { on: "end" })], [{ type: "if", cond: { type: "compare", var: "trigger.durationMs", op: "gte", value: 2000 }, then: [speak("long")], else: [speak("short")] }])],
            on,
        );
        h.engine.onSignals([ev("smile", "start")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(0);
        h.engine.onSignals([ev("smile", "end", { durationMs: 2500 })]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toEqual([["speak", "long"]]);
    });

    it("fires a hold trigger once after holdMs", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("open_palm", { on: "hold", holdMs: 1000 })], [speak()])], on);
        h.engine.onSignals([ev("open_palm", "start")]);
        await vi.advanceTimersByTimeAsync(900);
        expect(h.calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(h.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(h.calls).toHaveLength(1);
        expect(h.fired[0]?.trigger).toBe("signal:open_palm:hold");
    });

    it("cancels a hold when the signal ends early", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("open_palm", { on: "hold", holdMs: 1000 })], [speak()])], on);
        h.engine.onSignals([ev("open_palm", "start")]);
        await vi.advanceTimersByTimeAsync(500);
        h.engine.onSignals([ev("open_palm", "end")]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.calls).toHaveLength(0);
    });

    it("re-arms a hold after the signal ends and starts again", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("fist", { on: "hold", holdMs: 300 })], [speak()])], on);
        h.engine.onSignals([ev("fist", "start")]);
        await vi.advanceTimersByTimeAsync(400);
        h.engine.onSignals([ev("fist", "end")]);
        h.engine.onSignals([ev("fist", "start", { at: Date.now() })]);
        await vi.advanceTimersByTimeAsync(400);
        expect(h.calls).toHaveLength(2);
    });

    it("respects minConfidence", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile", { minConfidence: 0.8 })], [speak()])], on);
        h.engine.onSignals([ev("smile", "pulse", { confidence: 0.7 })]);
        h.engine.onSignals([ev("smile", "pulse", { confidence: 0.85 })]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
    });

    it("filters by who: owner, anyDog, anyPerson, profile, anyone", async () => {
        const h = harness();
        const dog = { kind: "dog" as const, track: 1, owner: false, profileId: "koro" };
        const guest = { kind: "person" as const, track: 2, owner: false };
        h.engine.setRules(
            [
                rule("owner", [sig("dog_enter")], [speak("owner")]),
                rule("dog", [sig("dog_enter", { who: "anyDog" })], [speak("dog")]),
                rule("person", [sig("dog_enter", { who: "anyPerson" })], [speak("person")]),
                rule("koro", [sig("dog_enter", { who: "profile", profileId: "koro" })], [speak("koro")]),
                rule("any", [sig("dog_enter", { who: "anyone" })], [speak("any")]),
            ],
            on,
        );
        h.engine.onSignals([ev("dog_enter", "pulse", { subject: dog })]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.map((c) => c[1]).sort()).toEqual(["any", "dog", "koro"]);
        h.calls.length = 0;
        h.engine.onSignals([ev("dog_enter", "pulse", { subject: guest })]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.map((c) => c[1]).sort()).toEqual(["any", "person"]);
    });

    it("matches chat contains case-insensitively", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [{ type: "chat", contains: "DANS" }], [speak()])], on);
        h.engine.onChat(chat("chat", { text: "hai dans acum" }));
        h.engine.onChat(chat("chat", { text: "nimic" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
    });

    it("matches gifts by minDiamonds and exposes the value", async () => {
        const h = harness();
        h.engine.setRules(
            [rule("r", [{ type: "gift", minDiamonds: 10 }], [{ type: "if", cond: { type: "compare", var: "trigger.value", op: "eq", value: 15 }, then: [speak("ok")], else: [] }])],
            on,
        );
        h.engine.onChat(chat("gift", { giftDiamonds: 1, giftCount: 5 }));
        h.engine.onChat(chat("gift", { giftDiamonds: 5, giftCount: 3 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toEqual([["speak", "ok"]]);
    });

    it("matches follow and control triggers", async () => {
        const h = harness();
        h.engine.setRules([rule("f", [{ type: "follow" }], [speak("f")]), rule("c", [{ type: "control", action: "highlight" }], [speak("c")])], on);
        h.engine.onChat(chat("follow"));
        h.engine.onControl("highlight");
        h.engine.onControl("muteAssistant");
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.map((c) => c[1])).toEqual(["f", "c"]);
    });

    it("runs timer triggers and clears them on setRules", async () => {
        const h = harness();
        h.engine.setRules([rule("t", [{ type: "timer", everyMs: 1000 }], [speak()])], on);
        await vi.advanceTimersByTimeAsync(3500);
        expect(h.calls).toHaveLength(3);
        h.engine.setRules([], on);
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.calls).toHaveLength(3);
    });

    it("does nothing while the engine is disabled", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()])], { enabled: false, armWindowMs: 5000 });
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(0);
        expect(h.fired).toHaveLength(0);
    });

    /* conditions */

    it("evaluates all / any / not / compare in the guard", async () => {
        const h = harness({ "control.muted": false, "live.viewers": 50 });
        const when = {
            type: "all" as const,
            of: [
                { type: "not" as const, of: { type: "compare" as const, var: "control.muted" as const, op: "eq" as const, value: true } },
                {
                    type: "any" as const,
                    of: [
                        { type: "compare" as const, var: "live.viewers" as const, op: "gt" as const, value: 100 },
                        { type: "compare" as const, var: "live.viewers" as const, op: "gte" as const, value: 50 },
                    ],
                },
            ],
        };
        h.engine.setRules([rule("r", [sig("smile")], [speak()], { when })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
        h.vars["control.muted"] = true;
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
        expect(h.fired.at(-1)?.blocked).toBe("condition");
    });

    it("treats an unresolved variable as false", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()], { when: { type: "compare", var: "lastGift.ageMs", op: "lt", value: 60_000 } })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fired[0]?.blocked).toBe("condition");
    });

    it("evaluates signalActive against active owner signals", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("wink_left")], [{ type: "if", cond: { type: "signalActive", signal: "smile", who: "owner" }, then: [speak("yes")], else: [speak("no")] }])], on);
        h.engine.onSignals([ev("wink_left", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        h.engine.onSignals([ev("smile", "start"), ev("wink_left", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.map((c) => c[1])).toEqual(["no", "yes"]);
        expect(h.fired.map((f) => f.trace[0])).toEqual(["if:else", "if:then"]);
    });

    /* actions */

    it("waits, and records the trace in order", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak("a"), { type: "wait", ms: 1000 }, speak("b")])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.calls).toEqual([["speak", "a"]]);
        await vi.advanceTimersByTimeAsync(600);
        expect(h.calls).toEqual([["speak", "a"], ["speak", "b"]]);
        expect(h.fired[0]?.trace).toEqual(["speak", "wait", "speak"]);
    });

    it("repeats a block", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [{ type: "repeat", count: 3, do: [{ type: "vmuiFlash", color: "red" }] }])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(3);
    });

    it("runs parallel branches concurrently", async () => {
        const h = harness();
        h.engine.setRules(
            [rule("r", [sig("smile")], [{ type: "parallel", branches: [[{ type: "wait", ms: 1000 }, speak("a")], [{ type: "wait", ms: 1000 }, speak("b")]] }])],
            on,
        );
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(1001);
        expect(h.calls.map((c) => c[1]).sort()).toEqual(["a", "b"]);
    });

    it("stop ends the run", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak("a"), { type: "stop" }, speak("b")])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toEqual([["speak", "a"]]);
        expect(h.fired[0]?.trace).toEqual(["speak", "stop"]);
    });

    it("sets, increments and reads variables", async () => {
        const h = harness();
        h.engine.setRules(
            [
                rule("r", [sig("smile")], [
                    { type: "set", var: "var.a", op: "inc", value: 1 },
                    { type: "if", cond: { type: "compare", var: "var.a", op: "gte", value: 2 }, then: [speak("second")], else: [] },
                ]),
            ],
            on,
        );
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.engine.variable("var.a")).toBe(2);
        expect(h.calls).toEqual([["speak", "second"]]);
    });

    it("routes studio-side actions to sink.studio and control to sink.control", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [{ type: "effect", effect: "hearts" }, { type: "camera", action: "photo" }, { type: "control", action: "skipCurrent" }])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls.map((c) => c[0])).toEqual(["studio", "studio", "control"]);
    });

    it("blocks during the cooldown", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()], { cooldownMs: 2000 })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(1000);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(1500);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(2);
        expect(h.fired.filter((f) => f.blocked === "cooldown")).toHaveLength(1);
    });

    it("requires arming within the window", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("timeout")], [speak()], { requiresArm: true })], on);
        h.engine.onSignals([ev("timeout", "pulse")]);
        h.engine.onArm(true);
        h.engine.onSignals([ev("timeout", "pulse")]);
        await vi.advanceTimersByTimeAsync(6000);
        h.engine.onSignals([ev("timeout", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toHaveLength(1);
        expect(h.fired.filter((f) => f.blocked === "notArmed")).toHaveLength(2);
    });

    it("reports a disabled rule as blocked", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()], { enabled: false })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        expect(h.fired[0]).toMatchObject({ blocked: "disabled", trace: [] });
    });

    /* modes */

    const slow = (): RuleAction[] => [speak("go"), { type: "wait", ms: 1000 }, speak("done")];

    it("single mode ignores triggers while running", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], slow())], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(100);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.calls.map((c) => c[1])).toEqual(["go", "done"]);
        expect(h.fired.some((f) => f.blocked === "busy")).toBe(true);
    });

    it("restart mode aborts the running instance", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], slow(), { mode: "restart" })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(100);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.calls.map((c) => c[1])).toEqual(["go", "go", "done"]);
        expect(h.fired[0]?.trace).toContain("aborted");
    });

    it("queued mode runs FIFO", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], slow(), { mode: "queued" })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(100);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(h.calls.map((c) => c[1])).toEqual(["go", "done", "go", "done"]);
    });

    it("parallel mode runs instances side by side", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], slow(), { mode: "parallel" })], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(100);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.calls.map((c) => c[1])).toEqual(["go", "go", "done", "done"]);
    });

    /* guards and test */

    it("stops runaway loops at the step guard", async () => {
        const h = harness();
        const inner: RuleAction[] = [{ type: "set", var: "var.b", op: "inc", value: 1 }];
        h.engine.setRules([rule("r", [sig("smile")], [{ type: "repeat", count: 50, do: [{ type: "repeat", count: 50, do: inner }] }])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.engine.variable("var.b")).toBeLessThan(MAX_STEPS);
        expect(h.fired[0]?.trace).toContain("guard:steps");
    });

    it("stops a run whose waits exceed 10 minutes", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [{ type: "repeat", count: 3, do: [{ type: "wait", ms: 300_000 }, speak()] }])], on);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(700_000);
        expect(h.calls).toHaveLength(2);
        expect(h.fired[0]?.trace).toContain("guard:wait");
    });

    it("test() runs ignoring triggers, cooldown and arming", async () => {
        const h = harness();
        h.engine.setRules([rule("r", [sig("smile")], [speak()], { requiresArm: true, cooldownMs: 60_000 })], on);
        const first = h.engine.test("r");
        const second = h.engine.test("r");
        await vi.advanceTimersByTimeAsync(0);
        expect((await first)?.trigger).toBe("test");
        await second;
        expect(h.calls).toHaveLength(2);
        expect(h.engine.test("missing")).toBeNull();
        expect(h.engine.firedCount("r")).toBe(2);
    });

    it("exposes rule.firedCount to conditions", async () => {
        const h = harness();
        h.engine.setRules(
            [rule("r", [sig("smile")], [{ type: "if", cond: { type: "compare", var: "rule.firedCount", op: "eq", value: 2 }, then: [speak("2nd")], else: [] }])],
            on,
        );
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        h.engine.onSignals([ev("smile", "pulse")]);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.calls).toEqual([["speak", "2nd"]]);
    });

    it("does not let a rule's own control action re-trigger control rules", async () => {
        const engineRef: { e?: RulesEngine } = {};
        const fired: RuleFired[] = [];
        const engine = new RulesEngine({
            sink: { ...noopSink(), control: (a) => engineRef.e?.onControl(a) },
            vars: () => undefined,
            onFired: (f) => fired.push(f),
        });
        engineRef.e = engine;
        engine.setRules([rule("loop", [{ type: "control", action: "highlight" }], [{ type: "control", action: "highlight" }])], on);
        engine.onControl("highlight");
        await vi.advanceTimersByTimeAsync(0);
        expect(fired).toHaveLength(1);
    });
});

function noopSink(): ActionSink {
    const n = (): void => undefined;
    return { control: n, speak: n, vmuiFlash: n, vmuiScene: n, highlight: n, notify: n, studio: n };
}
