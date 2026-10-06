import dagre from "@dagrejs/dagre";

import type { RuleGraph, XY } from "./rule-graph.js";

export const NODE_W = 220;
export const NODE_H = 76;

/** Left-to-right auto layout. Only nodes in `only` (default: all) get a new position. */
export function autoLayout(graph: RuleGraph, only?: ReadonlySet<string>): Map<string, XY> {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 70, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    for (const e of graph.edges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    const out = new Map<string, XY>();
    for (const n of graph.nodes) {
        if (only && !only.has(n.id)) continue;
        const p = g.node(n.id) as { x: number; y: number } | undefined;
        if (p) out.set(n.id, { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) });
    }
    return out;
}

/** True when the rule has no saved positions yet (every node at the origin). */
export function needsLayout(graph: RuleGraph): boolean {
    return graph.nodes.every((n) => n.position.x === 0 && n.position.y === 0);
}
