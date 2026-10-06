import "@xyflow/react/dist/style.css";

import type { Rule } from "@tiksee/core";
import { Button, cn } from "@tiksee/ui";
import {
    Background,
    Controls,
    Handle,
    MiniMap,
    Position,
    ReactFlow,
    ReactFlowProvider,
    applyEdgeChanges,
    applyNodeChanges,
    type Connection,
    type Edge,
    type EdgeChange,
    type Node,
    type NodeChange,
    type NodeProps,
} from "@xyflow/react";
import { LayoutGrid, Plus, Trash2, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ACTION_CATEGORIES, ACTION_EMOJI, defaultAction, defaultCondition, defaultTrigger } from "../../lib/vision/catalog.js";
import { autoLayout, needsLayout, NODE_H, NODE_W } from "../../lib/vision/graph-layout.js";
import {
    GATE_ID,
    GATE_OUT,
    NEXT,
    actionHandles,
    connect,
    graphToRule,
    removeNodes,
    ruleToGraph,
    type RuleEdge,
    type RuleGraph,
    type RuleNodeData,
} from "../../lib/vision/rule-graph.js";
import { useVisionLabels } from "../../lib/vision/use-vision.js";
import { MiniSelect } from "./fields.js";
import { ActionFields, ConditionBuilder, TriggerForm } from "./rule-forms.js";

type FlowNode = Node<RuleNodeData>;

const HANDLE_TONE: Record<string, string> = {
    then: "var(--success)",
    else: "var(--danger)",
    body: "var(--kind-join)",
    [NEXT]: "var(--accent)",
    [GATE_OUT]: "var(--accent)",
};

function toFlowNodes(graph: RuleGraph): FlowNode[] {
    return graph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        deletable: n.id !== GATE_ID,
        width: NODE_W,
    }));
}

function toFlowEdges(edges: readonly RuleEdge[]): Edge[] {
    return edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        style: { stroke: HANDLE_TONE[e.sourceHandle] ?? "var(--fg-subtle)", strokeWidth: 2 },
    }));
}

function fromFlow(nodes: readonly FlowNode[], edges: readonly Edge[]): RuleGraph {
    return {
        nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, position: n.position, data: n.data })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? NEXT })),
    };
}

/* ------------------------------------------------------------------ *
 * Node components
 * ------------------------------------------------------------------ */

function Shell({ selected, tone, children }: { selected: boolean; tone: string; children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "surface rounded-chip border px-3 py-2 text-left text-xs text-fg shadow-sm",
                selected ? "ring-2 ring-ring" : "",
            )}
            style={{ width: NODE_W, minHeight: NODE_H - 16, borderColor: `color-mix(in oklab, ${tone} 55%, transparent)` }}
        >
            {children}
        </div>
    );
}

function TriggerNodeView({ data, selected }: NodeProps<FlowNode>) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    if (data.kind !== "trigger") return null;
    return (
        <Shell selected={selected} tone="var(--kind-gift)">
            <p className="text-[0.625rem] font-bold uppercase tracking-wide text-[var(--kind-gift)]">{t("vision.graph.trigger")}</p>
            <p className="line-clamp-2">{labels.trigger(data.trigger)}</p>
            <Handle type="source" id={NEXT} position={Position.Right} style={{ background: "var(--kind-gift)" }} />
        </Shell>
    );
}

function GateNodeView({ data, selected }: NodeProps<FlowNode>) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    if (data.kind !== "gate") return null;
    return (
        <Shell selected={selected} tone="var(--kind-join)">
            <Handle type="target" position={Position.Left} style={{ background: "var(--kind-join)" }} />
            <p className="text-[0.625rem] font-bold uppercase tracking-wide text-[var(--kind-join)]">{t("vision.graph.gate")}</p>
            <p className="line-clamp-2">{labels.condition(data.cond)}</p>
            <Handle type="source" id={GATE_OUT} position={Position.Right} style={{ background: "var(--accent)" }} />
        </Shell>
    );
}

function ActionNodeView({ data, selected }: NodeProps<FlowNode>) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    if (data.kind !== "action") return null;
    const handles = actionHandles(data.action);
    return (
        <Shell selected={selected} tone="var(--accent)">
            <Handle type="target" position={Position.Left} style={{ background: "var(--fg-subtle)" }} />
            <p className="text-[0.625rem] font-bold uppercase tracking-wide text-accent">{labels.actionType(data.action.type)}</p>
            <p className="line-clamp-2 pr-10">{labels.action(data.action)}</p>
            {handles.map((h, i) => {
                const top = `${((i + 1) / (handles.length + 1)) * 100}%`;
                return (
                    <div key={h}>
                        <span
                            className="pointer-events-none absolute right-3 -translate-y-1/2 text-[0.5625rem] font-semibold text-fg-muted"
                            style={{ top }}
                        >
                            {h === NEXT ? t("vision.graph.next") : h.startsWith("b") && h !== "body" ? `#${Number(h.slice(1)) + 1}` : t(`vision.graph.${h}`)}
                        </span>
                        <Handle type="source" id={h} position={Position.Right} style={{ top, background: HANDLE_TONE[h] ?? "var(--kind-share)" }} />
                    </div>
                );
            })}
        </Shell>
    );
}

const NODE_TYPES = { trigger: TriggerNodeView, gate: GateNodeView, action: ActionNodeView };

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

export interface RuleGraphEditorProps {
    rule: Rule;
    onChange: (rule: Rule) => void;
    arObjectIds: readonly string[];
}

/** Mount with `key={rule.id}`: the graph owns its working copy (incl. unconnected nodes) while open. */
export function RuleGraphEditor(props: RuleGraphEditorProps) {
    return (
        <ReactFlowProvider>
            <GraphEditorInner {...props} />
        </ReactFlowProvider>
    );
}

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

function initialGraph(rule: Rule): RuleGraph {
    const g = ruleToGraph(rule);
    if (!needsLayout(g)) {
        // New paths without a saved position get placed by the layout, the rest stay.
        const missing = new Set(g.nodes.filter((n) => rule.ui.graph[n.id] === undefined).map((n) => n.id));
        if (missing.size === 0) return g;
        const placed = autoLayout(g, missing);
        return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position })) };
    }
    const placed = autoLayout(g);
    return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position })) };
}

function GraphEditorInner({ rule, onChange, arObjectIds }: RuleGraphEditorProps) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    const [init] = useState(() => initialGraph(rule));
    const [nodes, setNodes] = useState<FlowNode[]>(() => toFlowNodes(init));
    const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(init.edges));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [orphans, setOrphans] = useState<string[]>([]);
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

    const emit = useCallback(
        (ns: FlowNode[], es: Edge[]) => {
            const result = graphToRule(fromFlow(ns, es), rule);
            setOrphans(result.orphans);
            onChange(result.rule);
        },
        [onChange, rule],
    );

    const commit = useCallback(
        (graph: RuleGraph) => {
            const ns = toFlowNodes(graph).map((n) => ({ ...n, selected: n.id === selectedId }));
            const es = toFlowEdges(graph.edges);
            setNodes(ns);
            setEdges(es);
            emit(ns, es);
        },
        [emit, selectedId],
    );

    const graph = useMemo(() => fromFlow(nodes, edges), [nodes, edges]);

    const onNodesChange = useCallback(
        (changes: NodeChange<FlowNode>[]) => {
            // Removals are handled once, in onDelete, with nodes and edges together.
            const rest = changes.filter((c) => c.type !== "remove");
            setNodes((ns) => applyNodeChanges(rest, ns));
            for (const c of rest) if (c.type === "select" && c.selected) setSelectedId(c.id);
        },
        [],
    );

    const onEdgesChange = useCallback((changes: EdgeChange[]) => {
        const rest = changes.filter((c) => c.type !== "remove");
        setEdges((es) => applyEdgeChanges(rest, es));
    }, []);

    const onDelete = useCallback(
        ({ nodes: goneNodes, edges: goneEdges }: { nodes: FlowNode[]; edges: Edge[] }) => {
            const nodeIds = new Set(goneNodes.map((n) => n.id));
            const edgeIds = new Set(goneEdges.map((e) => e.id));
            const g = removeNodes(fromFlow(nodes, edges), nodeIds);
            commit({ nodes: g.nodes, edges: g.edges.filter((e) => !edgeIds.has(e.id)) });
            if (selectedId && nodeIds.has(selectedId)) setSelectedId(null);
        },
        [commit, nodes, edges, selectedId],
    );

    const onConnect = useCallback(
        (c: Connection) => {
            if (!c.source || !c.target) return;
            commit(connect(fromFlow(nodes, edges), c.source, c.sourceHandle ?? NEXT, c.target));
        },
        [commit, nodes, edges],
    );

    const onNodeDragStop = useCallback(() => emit(nodes, edges), [emit, nodes, edges]);

    const relayout = () => {
        const placed = autoLayout(graph);
        commit({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position })) });
    };

    const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;

    /** New node to the right of the selection, auto-linked from its first free handle. */
    const addNode = (data: RuleNodeData) => {
        const id = data.kind === "trigger" ? newId("t") : newId("a");
        const anchor = selected ?? graph.nodes.find((n) => n.id === GATE_ID);
        const position = anchor
            ? { x: anchor.position.x + (data.kind === "trigger" ? -NODE_W - 60 : NODE_W + 60), y: anchor.position.y + 20 }
            : { x: 0, y: 0 };
        let next: RuleGraph = { nodes: [...graph.nodes, { id, type: data.kind, position, data }], edges: graph.edges };
        if (data.kind === "trigger") next = connect(next, id, NEXT, GATE_ID);
        else if (selected && selected.data.kind !== "trigger") {
            const handles = selected.data.kind === "gate" ? [GATE_OUT] : actionHandles(selected.data.action);
            const free = handles.find((h) => !next.edges.some((e) => e.source === selected.id && e.sourceHandle === h));
            if (free) next = connect(next, selected.id, free, id);
        }
        setSelectedId(id);
        commit(next);
    };

    const updateData = (id: string, data: RuleNodeData) => {
        const nodesNext = graph.nodes.map((n) => (n.id === id ? { ...n, data } : n));
        // A parallel node may have lost branch handles.
        const valid = (e: RuleEdge) => {
            const src = nodesNext.find((n) => n.id === e.source);
            if (!src || src.data.kind !== "action") return true;
            return actionHandles(src.data.action).includes(e.sourceHandle);
        };
        commit({ nodes: nodesNext, edges: graph.edges.filter(valid) });
    };

    const triggerCount = graph.nodes.filter((n) => n.data.kind === "trigger").length;

    return (
        <div className="flex min-h-[32rem] flex-col gap-2 lg:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={t("vision.graph.palette")}>
                    <Button size="sm" variant="soft" icon={<Zap />} disabled={triggerCount >= 8} onClick={() => addNode({ kind: "trigger", trigger: defaultTrigger("signal") })}>
                        {t("vision.graph.addTrigger")}
                    </Button>
                    <PaletteSelect onAdd={(type) => addNode({ kind: "action", action: defaultAction(type) })} />
                    <Button size="sm" variant="ghost" icon={<LayoutGrid />} onClick={relayout}>
                        {t("vision.graph.autoLayout")}
                    </Button>
                    <span className="ml-auto text-[0.6875rem] text-fg-subtle">{t("vision.graph.help")}</span>
                </div>
                {orphans.length > 0 && (
                    <p role="status" className="rounded-chip bg-warning/15 px-2 py-1 text-[0.6875rem] text-warning">
                        {t("vision.graph.orphans", { count: orphans.length })}
                    </p>
                )}
                <div className="h-[30rem] overflow-hidden rounded-card border border-border/70 bg-panel-alt">
                    <ReactFlow<FlowNode>
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={NODE_TYPES}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onDelete={onDelete}
                        onConnect={onConnect}
                        onNodeDragStop={onNodeDragStop}
                        onPaneClick={() => setSelectedId(null)}
                        colorMode={dark ? "dark" : "light"}
                        deleteKeyCode={["Delete", "Backspace"]}
                        fitView
                        minZoom={0.2}
                        proOptions={{ hideAttribution: true }}
                        ariaLabelConfig={{ "node.a11yDescription.default": t("vision.graph.nodeA11y") }}
                    >
                        <Background gap={20} />
                        <Controls showInteractive={false} />
                        <MiniMap pannable zoomable className="bg-panel!" />
                    </ReactFlow>
                </div>
            </div>

            <aside className="w-full shrink-0 lg:w-80" aria-label={t("vision.graph.inspector")}>
                {selected ? (
                    <div className="surface flex flex-col gap-3 rounded-card p-3">
                        <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-xs font-semibold">
                                {selected.data.kind === "trigger"
                                    ? t("vision.graph.trigger")
                                    : selected.data.kind === "gate"
                                      ? t("vision.graph.gate")
                                      : labels.actionType(selected.data.action.type)}
                            </p>
                            {selected.id !== GATE_ID && (
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={t("vision.graph.deleteNode")}
                                    title={t("vision.graph.deleteNode")}
                                    disabled={selected.data.kind === "trigger" && triggerCount <= 1}
                                    onClick={() => {
                                        setSelectedId(null);
                                        commit(removeNodes(graph, new Set([selected.id])));
                                    }}
                                >
                                    <Trash2 />
                                </Button>
                            )}
                        </div>
                        {selected.data.kind === "trigger" && (
                            <TriggerForm trigger={selected.data.trigger} onChange={(trigger) => updateData(selected.id, { kind: "trigger", trigger })} />
                        )}
                        {selected.data.kind === "gate" &&
                            (selected.data.cond ? (
                                <ConditionBuilder
                                    cond={selected.data.cond}
                                    onChange={(cond) => updateData(selected.id, { kind: "gate", cond })}
                                    onRemove={() => updateData(selected.id, { kind: "gate", cond: undefined })}
                                />
                            ) : (
                                <Button size="sm" variant="soft" icon={<Plus />} onClick={() => updateData(selected.id, { kind: "gate", cond: { type: "all", of: [defaultCondition("compare")] } })}>
                                    {t("vision.editor.addWhen")}
                                </Button>
                            ))}
                        {selected.data.kind === "action" && (
                            <ActionFields
                                action={selected.data.action}
                                arObjectIds={arObjectIds}
                                onChange={(action) => updateData(selected.id, { kind: "action", action })}
                            />
                        )}
                        {selected.data.kind !== "trigger" && <ConnectFields graph={graph} nodeId={selected.id} onConnect={(h, target) => commit(target ? connect(graph, selected.id, h, target) : { ...graph, edges: graph.edges.filter((e) => !(e.source === selected.id && e.sourceHandle === h)) })} />}
                    </div>
                ) : (
                    <p className="rounded-card border border-dashed border-border p-3 text-xs text-fg-muted">{t("vision.graph.selectHint")}</p>
                )}
            </aside>
        </div>
    );
}

/** Keyboard path for connecting: pick the target of each output handle. */
function ConnectFields({ graph, nodeId, onConnect }: { graph: RuleGraph; nodeId: string; onConnect: (handle: string, target: string | null) => void }) {
    const { t } = useTranslation();
    const labels = useVisionLabels();
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.data.kind === "trigger") return null;
    const handles = node.data.kind === "gate" ? [GATE_OUT] : actionHandles(node.data.action);
    const targets = graph.nodes.filter((n): n is typeof n & { data: { kind: "action" } } => n.data.kind === "action" && n.id !== nodeId);
    return (
        <fieldset className="flex flex-col gap-2 border-t border-border/60 pt-2">
            <legend className="text-[0.6875rem] font-semibold text-fg-muted">{t("vision.graph.connections")}</legend>
            {handles.map((h) => {
                const current = graph.edges.find((e) => e.source === nodeId && e.sourceHandle === h)?.target ?? "";
                const name = h === NEXT || h === GATE_OUT ? t("vision.graph.next") : h.startsWith("b") && h !== "body" ? t("vision.editor.branch", { n: Number(h.slice(1)) + 1 }) : t(`vision.graph.${h}`);
                return (
                    <MiniSelect
                        key={h}
                        label={name}
                        value={current}
                        options={[{ value: "", label: t("vision.graph.noTarget") }, ...targets.map((n) => ({ value: n.id, label: labels.action(n.data.action) }))]}
                        onChange={(v) => onConnect(h, v === "" ? null : v)}
                    />
                );
            })}
        </fieldset>
    );
}

function PaletteSelect({ onAdd }: { onAdd: (type: Parameters<typeof defaultAction>[0]) => void }) {
    const { t } = useTranslation();
    return (
        <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <Plus className="size-3.5" aria-hidden />
            <span className="sr-only">{t("vision.graph.addNode")}</span>
            <select
                value=""
                aria-label={t("vision.graph.addNode")}
                onChange={(e) => {
                    if (e.target.value) onAdd(e.target.value as Parameters<typeof defaultAction>[0]);
                }}
                className="no-drag h-8 rounded-chip border border-border bg-panel px-2 text-xs text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring/40"
            >
                <option value="">{t("vision.graph.addNode")}</option>
                {ACTION_CATEGORIES.map((cat) => (
                    <optgroup key={cat.id} label={t(`vision.actionCategories.${cat.id}`)}>
                        {cat.types.map((type) => (
                            <option key={type} value={type}>
                                {ACTION_EMOJI[type]} {t(`vision.actionTypes.${type}`)}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>
        </label>
    );
}

export default RuleGraphEditor;
