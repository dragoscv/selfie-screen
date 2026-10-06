import type { Condition, Rule, RuleAction, Trigger } from "@tiksee/core";

/**
 * Pure projection between the rule tree (the source of truth) and a node graph.
 *
 * Layout of the graph:
 *   trigger nodes (t0, t1, ...) ──> gate (w, the optional `when` guard) ──out──> a0 ──next──> a1 ...
 *   `if` nodes have `then` / `else` handles, `repeat` has `body`, `parallel` has `b0`, `b1`, ...
 * Node ids produced by `ruleToGraph` are tree paths ("a0.then.1"), which are also the keys of
 * `rule.ui.graph` positions. `graphToRule` rebuilds the tree from edges only, so nodes added in the
 * editor may carry any id; unreachable action nodes are reported as orphans and dropped.
 */

export interface XY {
    x: number;
    y: number;
}

export type TriggerNodeData = { kind: "trigger"; trigger: Trigger };
export type GateNodeData = { kind: "gate"; cond: Condition | undefined };
/** `action` has its child lists emptied; the edges carry the children. */
export type ActionNodeData = { kind: "action"; action: RuleAction };
export type RuleNodeData = TriggerNodeData | GateNodeData | ActionNodeData;

export interface RuleNode {
    id: string;
    type: RuleNodeData["kind"];
    position: XY;
    data: RuleNodeData;
}

export interface RuleEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle?: string;
}

export interface RuleGraph {
    nodes: RuleNode[];
    edges: RuleEdge[];
}

export const GATE_ID = "w";
export const GATE_OUT = "out";
export const NEXT = "next";

export const edgeId = (source: string, handle: string, target: string): string => `${source}:${handle}->${target}`;

/** Output handles of an action node, in display order. */
export function actionHandles(action: RuleAction): string[] {
    switch (action.type) {
        case "if":
            return ["then", "else", NEXT];
        case "repeat":
            return ["body", NEXT];
        case "parallel":
            return [...action.branches.map((_, k) => `b${k}`), NEXT];
        default:
            return [NEXT];
    }
}

/** Shallow copy with child lists emptied (branch count of `parallel` is kept). */
export function stripChildren(action: RuleAction): RuleAction {
    switch (action.type) {
        case "if":
            return { ...action, then: [], else: [] };
        case "repeat":
            return { ...action, do: [] };
        case "parallel":
            return { ...action, branches: action.branches.map(() => []) };
        default:
            return { ...action };
    }
}

function childLists(action: RuleAction): Array<{ handle: string; seg: string; list: RuleAction[] }> {
    switch (action.type) {
        case "if":
            return [
                { handle: "then", seg: "then", list: action.then },
                { handle: "else", seg: "else", list: action.else },
            ];
        case "repeat":
            return [{ handle: "body", seg: "do", list: action.do }];
        case "parallel":
            return action.branches.map((list, k) => ({ handle: `b${k}`, seg: `b${k}`, list }));
        default:
            return [];
    }
}

export function ruleToGraph(rule: Rule): RuleGraph {
    const saved = rule.ui.graph;
    const pos = (id: string): XY => {
        const p = saved[id];
        return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
    };
    const nodes: RuleNode[] = [];
    const edges: RuleEdge[] = [];
    const link = (source: string, handle: string, target: string) =>
        edges.push({ id: edgeId(source, handle, target), source, target, sourceHandle: handle });

    rule.triggers.forEach((trigger, i) => {
        const id = `t${i}`;
        nodes.push({ id, type: "trigger", position: pos(id), data: { kind: "trigger", trigger: { ...trigger } } });
        link(id, NEXT, GATE_ID);
    });
    nodes.push({ id: GATE_ID, type: "gate", position: pos(GATE_ID), data: { kind: "gate", cond: rule.when } });

    const walk = (list: readonly RuleAction[], prefix: string, from: string, handle: string) => {
        let prev = from;
        let prevHandle = handle;
        list.forEach((action, i) => {
            const id = `${prefix}${i}`;
            nodes.push({ id, type: "action", position: pos(id), data: { kind: "action", action: stripChildren(action) } });
            link(prev, prevHandle, id);
            for (const child of childLists(action)) walk(child.list, `${id}.${child.seg}.`, id, child.handle);
            prev = id;
            prevHandle = NEXT;
        });
    };
    walk(rule.actions, "a", GATE_ID, GATE_OUT);
    return { nodes, edges };
}

export interface GraphToRuleResult {
    rule: Rule;
    /** Action nodes not reachable from the gate (not saved). */
    orphans: string[];
}

export function graphToRule(graph: RuleGraph, base: Rule): GraphToRuleResult {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const out = new Map<string, string>();
    for (const e of graph.edges) {
        const key = `${e.source}\u0000${e.sourceHandle}`;
        if (!out.has(key)) out.set(key, e.target);
    }
    const next = (source: string, handle: string): string | undefined => out.get(`${source}\u0000${handle}`);

    const ui: Record<string, XY> = {};
    const visited = new Set<string>();

    const walk = (start: string | undefined, prefix: string): RuleAction[] => {
        const list: RuleAction[] = [];
        let cur = start;
        while (cur !== undefined && !visited.has(cur)) {
            const node = byId.get(cur);
            if (!node || node.data.kind !== "action") break;
            visited.add(cur);
            const path = `${prefix}${list.length}`;
            ui[path] = { x: node.position.x, y: node.position.y };
            const a = node.data.action;
            const id = cur;
            let built: RuleAction;
            switch (a.type) {
                case "if":
                    built = { ...a, then: walk(next(id, "then"), `${path}.then.`), else: walk(next(id, "else"), `${path}.else.`) };
                    break;
                case "repeat":
                    built = { ...a, do: walk(next(id, "body"), `${path}.do.`) };
                    break;
                case "parallel":
                    built = { ...a, branches: a.branches.map((_, k) => walk(next(id, `b${k}`), `${path}.b${k}.`)) };
                    break;
                default:
                    built = { ...a };
            }
            list.push(built);
            cur = next(id, NEXT);
        }
        return list;
    };

    const triggerNodes = graph.nodes.filter((n): n is RuleNode & { data: TriggerNodeData } => n.data.kind === "trigger");
    const triggers = triggerNodes.map((n, i) => {
        ui[`t${i}`] = { x: n.position.x, y: n.position.y };
        return { ...n.data.trigger };
    });

    const gate = graph.nodes.find((n): n is RuleNode & { data: GateNodeData } => n.data.kind === "gate");
    if (gate) ui[GATE_ID] = { x: gate.position.x, y: gate.position.y };
    const actions = gate ? walk(next(gate.id, GATE_OUT), "a") : [];
    const orphans = graph.nodes.filter((n) => n.data.kind === "action" && !visited.has(n.id)).map((n) => n.id);

    const rule: Rule = { ...base, triggers, actions, ui: { graph: ui } };
    if (gate?.data.cond !== undefined) rule.when = gate.data.cond;
    else delete rule.when;
    return { rule, orphans };
}

/**
 * Connect `source[handle]` to `target`, keeping the graph a tree: a handle has at most one
 * outgoing edge and an action node at most one incoming edge (the gate accepts many triggers).
 */
export function connect(graph: RuleGraph, source: string, handle: string, target: string): RuleGraph {
    if (source === target) return graph;
    const targetNode = graph.nodes.find((n) => n.id === target);
    if (!targetNode || targetNode.data.kind === "trigger") return graph;
    const sourceNode = graph.nodes.find((n) => n.id === source);
    if (!sourceNode) return graph;
    // Triggers feed only the gate; the gate and actions feed only actions.
    if ((sourceNode.data.kind === "trigger") !== (targetNode.data.kind === "gate")) return graph;
    const edges = graph.edges.filter(
        (e) =>
            !(e.source === source && e.sourceHandle === handle) &&
            !(targetNode.data.kind === "action" && e.target === target),
    );
    edges.push({ id: edgeId(source, handle, target), source, target, sourceHandle: handle });
    return { nodes: graph.nodes, edges };
}

/** Remove nodes (never the gate) and every edge touching them. */
export function removeNodes(graph: RuleGraph, ids: ReadonlySet<string>): RuleGraph {
    const drop = new Set([...ids].filter((id) => id !== GATE_ID));
    return {
        nodes: graph.nodes.filter((n) => !drop.has(n.id)),
        edges: graph.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target)),
    };
}

/** True when the node (or the gate) has no outgoing edge on `handle`. */
export function handleFree(graph: RuleGraph, source: string, handle: string): boolean {
    return !graph.edges.some((e) => e.source === source && e.sourceHandle === handle);
}
