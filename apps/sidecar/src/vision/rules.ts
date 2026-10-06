import {
    eventDiamonds,
    isStudioSideAction,
    type ChatEvent,
    type Condition,
    type ControlAction,
    type Rule,
    type RuleAction,
    type RuleFired,
    type RuleVar,
    type SignalEvent,
    type SignalId,
    type Subject,
    type Trigger,
} from "@tiksee/core";

/**
 * Vision rules engine (0.3.0): triggers -> guard -> action tree.
 *
 * Pure orchestration: every side effect goes through the injected
 * `ActionSink`, every external value through the `VarResolver`, so the whole
 * thing is testable with fake timers and no hub.
 */

export type VarValue = number | boolean | undefined;
export type VarResolver = (name: RuleVar) => VarValue;

type StudioAction = Extract<RuleAction, { type: "camera" | "studio" | "effect" | "arObject" | "pet" }>;

export interface ActionSink {
    control(action: ControlAction): void | Promise<unknown>;
    speak(text: string): void | Promise<unknown>;
    vmuiFlash(color: string): void | Promise<unknown>;
    vmuiScene(scene: string): void | Promise<unknown>;
    highlight(label: string | undefined): void | Promise<unknown>;
    notify(text: string): void | Promise<unknown>;
    /** Actions only the studio window can perform; relayed as `ruleAction`. */
    studio(action: StudioAction, ruleId: string): void | Promise<unknown>;
}

export interface RulesEngineDeps {
    sink: ActionSink;
    vars: VarResolver;
    onFired: (fired: RuleFired) => void;
    now?: () => number;
}

export interface RulesOptions {
    enabled: boolean;
    armWindowMs: number;
}

export type BlockedReason = "cooldown" | "notArmed" | "condition" | "busy" | "disabled";

export const MAX_STEPS = 500;
export const MAX_WAIT_MS = 600_000;
export const HOLD_TICK_MS = 100;
const MAX_TRACE = 200;
const MAX_QUEUED = 10;
const MAX_PARALLEL = 10;

interface TriggerContext {
    confidence?: number;
    value?: number;
    durationMs?: number;
}

interface ActiveSignal {
    signal: SignalId;
    subject: Subject;
    confidence: number;
    value?: number;
    startedAt: number;
    /** `${ruleId}:${triggerIndex}` hold triggers already fired for this activation. */
    held: Set<string>;
}

interface Run {
    rule: Rule;
    trigger: string;
    ctx: TriggerContext;
    at: number;
    abort: AbortController;
    steps: number;
    waitedMs: number;
    trace: string[];
}

type SignalTrigger = Extract<Trigger, { type: "signal" }>;

function subjectKey(signal: SignalId, subject: Subject): string {
    return `${signal}#${subject.kind}#${subject.track}`;
}

function whoMatches(trigger: SignalTrigger, subject: Subject): boolean {
    switch (trigger.who) {
        case "owner":
            return subject.owner;
        case "anyPerson":
            return subject.kind === "person";
        case "anyDog":
            return subject.kind === "dog";
        case "anyone":
            return true;
        case "profile":
            return trigger.profileId !== undefined && subject.profileId === trigger.profileId;
    }
}

function compare(left: VarValue, op: Extract<Condition, { type: "compare" }>["op"], right: number | boolean): boolean {
    if (left === undefined) return false;
    if (typeof left === "boolean" || typeof right === "boolean") {
        const a = typeof left === "boolean" ? left : left !== 0;
        const b = typeof right === "boolean" ? right : right !== 0;
        if (op === "eq") return a === b;
        if (op === "ne") return a !== b;
        // Ordering on booleans compares 0/1.
        const x = Number(a);
        const y = Number(b);
        return op === "lt" ? x < y : op === "lte" ? x <= y : op === "gt" ? x > y : x >= y;
    }
    switch (op) {
        case "eq":
            return left === right;
        case "ne":
            return left !== right;
        case "lt":
            return left < right;
        case "lte":
            return left <= right;
        case "gt":
            return left > right;
        case "gte":
            return left >= right;
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}

export class RulesEngine {
    #deps: RulesEngineDeps;
    #now: () => number;
    #rules: Rule[] = [];
    #enabled = false;
    #armWindowMs = 5000;
    #armedAt: number | undefined;

    #active = new Map<string, ActiveSignal>();
    #holdTimer: ReturnType<typeof setInterval> | null = null;
    #timers: ReturnType<typeof setInterval>[] = [];

    #lastFired = new Map<string, number>();
    #firedCount = new Map<string, number>();
    #runs = new Map<string, Set<Run>>();
    #queues = new Map<string, { trigger: string; ctx: TriggerContext }[]>();
    #vars: Record<"var.a" | "var.b" | "var.c", number> = { "var.a": 0, "var.b": 0, "var.c": 0 };
    /** Set while a rule's own `control` action runs, so it cannot re-trigger control rules. */
    #inControl = false;

    constructor(deps: RulesEngineDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? (() => Date.now());
    }

    get rules(): readonly Rule[] {
        return this.#rules;
    }

    get armed(): boolean {
        return this.#armedAt !== undefined && this.#now() - this.#armedAt <= this.#armWindowMs;
    }

    firedCount(ruleId: string): number {
        return this.#firedCount.get(ruleId) ?? 0;
    }

    variable(name: "var.a" | "var.b" | "var.c"): number {
        return this.#vars[name];
    }

    setRules(rules: readonly Rule[], options: RulesOptions): void {
        this.#rules = [...rules];
        this.#enabled = options.enabled;
        this.#armWindowMs = options.armWindowMs;
        for (const timer of this.#timers) clearInterval(timer);
        this.#timers = [];
        const ids = new Set(this.#rules.map((r) => r.id));
        for (const [id, runs] of this.#runs) {
            if (!ids.has(id)) for (const run of runs) run.abort.abort();
        }
        for (const id of [...this.#queues.keys()]) if (!ids.has(id)) this.#queues.delete(id);
        if (!this.#enabled) {
            this.#stopHoldTimer();
            return;
        }
        for (const rule of this.#rules) {
            for (const trigger of rule.triggers) {
                if (trigger.type !== "timer") continue;
                const timer = setInterval(() => this.#attempt(rule, `timer:${trigger.everyMs}`, {}), trigger.everyMs);
                timer.unref?.();
                this.#timers.push(timer);
            }
        }
        this.#syncHoldTimer();
    }

    onArm(armed: boolean): void {
        this.#armedAt = armed ? this.#now() : undefined;
    }

    signalActive(signal: SignalId, who: "owner" | "anyone"): boolean {
        for (const entry of this.#active.values()) {
            if (entry.signal === signal && (who === "anyone" || entry.subject.owner)) return true;
        }
        return false;
    }

    onSignals(events: readonly SignalEvent[]): void {
        for (const event of events) {
            const key = subjectKey(event.signal, event.subject);
            if (event.phase === "start") {
                if (!this.#active.has(key)) {
                    this.#active.set(key, {
                        signal: event.signal,
                        subject: event.subject,
                        confidence: event.confidence,
                        ...(event.value !== undefined ? { value: event.value } : {}),
                        startedAt: event.at,
                        held: new Set(),
                    });
                }
            } else if (event.phase === "end") {
                this.#active.delete(key);
            }
            if (!this.#enabled) continue;
            this.#matchEdge(event);
        }
        if (this.#enabled) this.#checkHolds();
        this.#syncHoldTimer();
    }

    onChat(event: ChatEvent): void {
        if (!this.#enabled) return;
        for (const rule of this.#rules) {
            for (const trigger of rule.triggers) {
                if (trigger.type === "chat" && event.kind === "chat") {
                    if (event.text.toLowerCase().includes(trigger.contains.toLowerCase())) {
                        this.#attempt(rule, "chat", {});
                        break;
                    }
                } else if (trigger.type === "gift" && event.kind === "gift") {
                    const diamonds = eventDiamonds(event);
                    if (diamonds >= trigger.minDiamonds) {
                        this.#attempt(rule, "gift", { value: diamonds });
                        break;
                    }
                } else if (trigger.type === "follow" && event.kind === "follow") {
                    this.#attempt(rule, "follow", {});
                    break;
                }
            }
        }
    }

    onControl(action: ControlAction): void {
        if (!this.#enabled || this.#inControl) return;
        for (const rule of this.#rules) {
            if (rule.triggers.some((t) => t.type === "control" && t.action === action)) this.#attempt(rule, `control:${action}`, {});
        }
    }

    /** Editor "test": run the actions now, ignoring triggers, guard, cooldown and arm. */
    test(ruleId: string): Promise<RuleFired> | null {
        const rule = this.#rules.find((r) => r.id === ruleId);
        if (!rule) return null;
        return this.#start(rule, "test", {});
    }

    dispose(): void {
        for (const timer of this.#timers) clearInterval(timer);
        this.#timers = [];
        this.#stopHoldTimer();
        this.#queues.clear();
        for (const runs of this.#runs.values()) for (const run of runs) run.abort.abort();
    }

    /* ----------------------------- matching ----------------------------- */

    #matchEdge(event: SignalEvent): void {
        for (const rule of this.#rules) {
            for (const trigger of rule.triggers) {
                if (trigger.type !== "signal" || trigger.signal !== event.signal) continue;
                if (event.confidence < trigger.minConfidence || !whoMatches(trigger, event.subject)) continue;
                const startLike = event.phase === "start" || event.phase === "pulse";
                const matches =
                    (trigger.on === "start" && startLike) ||
                    (trigger.on === "end" && event.phase === "end") ||
                    // A momentary signal has no duration: only a zero hold can match it.
                    (trigger.on === "hold" && event.phase === "pulse" && trigger.holdMs === 0);
                if (!matches) continue;
                this.#attempt(rule, `signal:${event.signal}:${trigger.on}`, {
                    confidence: event.confidence,
                    ...(event.value !== undefined ? { value: event.value } : {}),
                    durationMs: event.durationMs ?? 0,
                });
                break;
            }
        }
    }

    #checkHolds(): void {
        const now = this.#now();
        for (const entry of this.#active.values()) {
            const age = now - entry.startedAt;
            for (const rule of this.#rules) {
                rule.triggers.forEach((trigger, index) => {
                    if (trigger.type !== "signal" || trigger.on !== "hold" || trigger.signal !== entry.signal) return;
                    if (entry.confidence < trigger.minConfidence || !whoMatches(trigger, entry.subject)) return;
                    if (age < trigger.holdMs) return;
                    const key = `${rule.id}:${index}`;
                    if (entry.held.has(key)) return;
                    entry.held.add(key);
                    this.#attempt(rule, `signal:${entry.signal}:hold`, {
                        confidence: entry.confidence,
                        ...(entry.value !== undefined ? { value: entry.value } : {}),
                        durationMs: age,
                    });
                });
            }
        }
    }

    #syncHoldTimer(): void {
        const needed = this.#enabled && this.#active.size > 0 && this.#rules.some((r) => r.triggers.some((t) => t.type === "signal" && t.on === "hold"));
        if (needed && !this.#holdTimer) {
            this.#holdTimer = setInterval(() => this.#checkHolds(), HOLD_TICK_MS);
            this.#holdTimer.unref?.();
        } else if (!needed) {
            this.#stopHoldTimer();
        }
    }

    #stopHoldTimer(): void {
        if (this.#holdTimer) clearInterval(this.#holdTimer);
        this.#holdTimer = null;
    }

    /* ----------------------------- gating ----------------------------- */

    #blocked(rule: Rule, trigger: string, reason: BlockedReason): void {
        this.#deps.onFired({ ruleId: rule.id, ruleName: rule.name, at: this.#now(), trigger, blocked: reason, trace: [] });
    }

    #attempt(rule: Rule, trigger: string, ctx: TriggerContext): void {
        const now = this.#now();
        if (!rule.enabled) return this.#blocked(rule, trigger, "disabled");
        if (rule.requiresArm && !this.armed) return this.#blocked(rule, trigger, "notArmed");
        const last = this.#lastFired.get(rule.id);
        if (last !== undefined && now - last < rule.cooldownMs) return this.#blocked(rule, trigger, "cooldown");
        if (rule.when && !this.#evaluate(rule.when, rule.id, ctx)) return this.#blocked(rule, trigger, "condition");

        const running = this.#runs.get(rule.id)?.size ?? 0;
        if (running > 0) {
            if (rule.mode === "single") return this.#blocked(rule, trigger, "busy");
            if (rule.mode === "queued") {
                const queue = this.#queues.get(rule.id) ?? [];
                if (queue.length >= MAX_QUEUED) return this.#blocked(rule, trigger, "busy");
                queue.push({ trigger, ctx });
                this.#queues.set(rule.id, queue);
                this.#lastFired.set(rule.id, now);
                return;
            }
            if (rule.mode === "restart") {
                for (const run of this.#runs.get(rule.id) ?? []) run.abort.abort("restart");
            }
            if (rule.mode === "parallel" && running >= MAX_PARALLEL) return this.#blocked(rule, trigger, "busy");
        }
        this.#lastFired.set(rule.id, now);
        void this.#start(rule, trigger, ctx);
    }

    /* ----------------------------- execution ----------------------------- */

    async #start(rule: Rule, trigger: string, ctx: TriggerContext): Promise<RuleFired> {
        this.#firedCount.set(rule.id, this.firedCount(rule.id) + 1);
        const run: Run = { rule, trigger, ctx, at: this.#now(), abort: new AbortController(), steps: 0, waitedMs: 0, trace: [] };
        const runs = this.#runs.get(rule.id) ?? new Set<Run>();
        runs.add(run);
        this.#runs.set(rule.id, runs);
        try {
            await this.#exec(rule.actions, run);
        } finally {
            runs.delete(run);
            if (runs.size === 0) this.#runs.delete(rule.id);
        }
        const reason: unknown = run.abort.signal.reason;
        if (run.abort.signal.aborted && reason !== "stop" && reason !== "guard") this.#trace(run, "aborted");
        const fired: RuleFired = { ruleId: rule.id, ruleName: rule.name, at: run.at, trigger, trace: run.trace };
        this.#deps.onFired(fired);

        const next = this.#queues.get(rule.id)?.shift();
        if (next && trigger !== "test") void this.#start(rule, next.trigger, next.ctx);
        return fired;
    }

    #trace(run: Run, entry: string): void {
        if (run.trace.length < MAX_TRACE) run.trace.push(entry);
        else if (entry.startsWith("guard:")) run.trace[MAX_TRACE - 1] = entry;
    }

    async #exec(actions: readonly RuleAction[], run: Run): Promise<void> {
        for (const action of actions) {
            if (run.abort.signal.aborted) return;
            run.steps += 1;
            if (run.steps > MAX_STEPS) {
                this.#trace(run, "guard:steps");
                run.abort.abort("guard");
                return;
            }
            await this.#step(action, run);
        }
    }

    async #call(run: Run, label: string, fn: () => void | Promise<unknown>): Promise<void> {
        this.#trace(run, label);
        try {
            await fn();
        } catch {
            this.#trace(run, `error:${label}`);
        }
    }

    async #step(action: RuleAction, run: Run): Promise<void> {
        const sink = this.#deps.sink;
        if (isStudioSideAction(action)) {
            await this.#call(run, action.type, () => sink.studio(action as StudioAction, run.rule.id));
            return;
        }
        switch (action.type) {
            case "control":
                await this.#call(run, "control", () => {
                    this.#inControl = true;
                    try {
                        return sink.control(action.action);
                    } finally {
                        this.#inControl = false;
                    }
                });
                return;
            case "speak":
                return this.#call(run, "speak", () => sink.speak(action.text));
            case "vmuiFlash":
                return this.#call(run, "vmuiFlash", () => sink.vmuiFlash(action.color));
            case "vmuiScene":
                return this.#call(run, "vmuiScene", () => sink.vmuiScene(action.scene));
            case "highlight":
                return this.#call(run, "highlight", () => sink.highlight(action.label));
            case "notify":
                return this.#call(run, "notify", () => sink.notify(action.text));
            case "set": {
                const current = this.#vars[action.var];
                this.#vars[action.var] = action.op === "set" ? action.value : action.op === "inc" ? current + action.value : current - action.value;
                this.#trace(run, "set");
                return;
            }
            case "if": {
                const ok = this.#evaluate(action.cond, run.rule.id, run.ctx);
                this.#trace(run, ok ? "if:then" : "if:else");
                await this.#exec(ok ? action.then : action.else, run);
                return;
            }
            case "wait": {
                if (run.waitedMs + action.ms > MAX_WAIT_MS) {
                    this.#trace(run, "guard:wait");
                    run.abort.abort("guard");
                    return;
                }
                run.waitedMs += action.ms;
                this.#trace(run, "wait");
                await sleep(action.ms, run.abort.signal);
                return;
            }
            case "repeat":
                this.#trace(run, "repeat");
                for (let i = 0; i < action.count && !run.abort.signal.aborted; i += 1) await this.#exec(action.do, run);
                return;
            case "parallel":
                this.#trace(run, "parallel");
                await Promise.all(action.branches.map((branch) => this.#exec(branch, run)));
                return;
            case "stop":
                this.#trace(run, "stop");
                run.abort.abort("stop");
                return;
            default:
                return;
        }
    }

    /* ----------------------------- conditions ----------------------------- */

    #resolve(name: RuleVar, ruleId: string, ctx: TriggerContext): VarValue {
        switch (name) {
            case "trigger.confidence":
                return ctx.confidence;
            case "trigger.value":
                return ctx.value;
            case "trigger.durationMs":
                return ctx.durationMs;
            case "rule.firedCount":
                return this.firedCount(ruleId);
            case "var.a":
            case "var.b":
            case "var.c":
                return this.#vars[name];
            case "vision.armed":
                return this.armed;
            default:
                return this.#deps.vars(name);
        }
    }

    #evaluate(cond: Condition, ruleId: string, ctx: TriggerContext): boolean {
        switch (cond.type) {
            case "all":
                return cond.of.every((c) => this.#evaluate(c, ruleId, ctx));
            case "any":
                return cond.of.some((c) => this.#evaluate(c, ruleId, ctx));
            case "not":
                return !this.#evaluate(cond.of, ruleId, ctx);
            case "compare":
                return compare(this.#resolve(cond.var, ruleId, ctx), cond.op, cond.value);
            case "signalActive":
                return this.signalActive(cond.signal, cond.who);
        }
    }
}
