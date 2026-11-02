import type { Edge } from "@xyflow/react";
import type { CanvasFlowNode } from "../lib/canvas/serialization";

export type HistoryGraph = { nodes: CanvasFlowNode[]; edges: Edge[] };
type Change<T> = { id: string; before?: T; after?: T };
export type CanvasHistoryEntry = { nodes: Change<CanvasFlowNode>[]; edges: Change<Edge>[]; key?: string; at: number };
// Media URLs may contain megabytes of original image data. Compare shared values
// first so moving a node never copies those bytes into temporary JSON strings.
export function canvasValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => canvasValuesEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => canvasValuesEqual(left[key], right[key]));
}
const equal = canvasValuesEqual;
const runtimeFields = new Set(['status', 'errorMessage', 'lastRunId', 'lastRunAt', 'costCredits']);
function userData(data: CanvasFlowNode['data']) { return Object.fromEntries(Object.entries(data).filter(([key]) => !runtimeFields.has(key))); }
function nodeValue(node: CanvasFlowNode) { return { position: node.position, width: node.width, height: node.height, data: userData(node.data) }; }
function edgeValue(edge: Edge) { return { source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, type: edge.type, data: edge.data }; }
function changes<T extends { id: string }>(before: T[], after: T[], value: (item: T) => unknown): Change<T>[] {
  const old = new Map(before.map(item => [item.id, item])), next = new Map(after.map(item => [item.id, item]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
    const a = old.get(id), b = next.get(id);
    return a === b || a && b && equal(value(a), value(b)) ? [] : [{ id, before: a, after: b }];
  });
}
export function historyEntry(before: HistoryGraph, after: HistoryGraph, key?: string): CanvasHistoryEntry | null {
  const nodes = changes(before.nodes, after.nodes, nodeValue), edges = changes(before.edges, after.edges, edgeValue);
  return nodes.length || edges.length ? { nodes, edges, key, at: Date.now() } : null;
}
function mergeFields<T extends object>(current: T, before: T, after: T): T {
  const result = { ...current } as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValue = (before as Record<string, unknown>)[key], nextValue = (after as Record<string, unknown>)[key];
    if (!equal(oldValue, nextValue)) result[key] = nextValue;
  }
  return result as T;
}
export function applyHistory(graph: HistoryGraph, entry: CanvasHistoryEntry, direction: "undo" | "redo"): HistoryGraph {
  const apply = <T extends { id: string }>(items: T[], mutations: Change<T>[], merge: (current: T, from: T, to: T) => T) => {
    const result = new Map(items.map(item => [item.id, item]));
    for (const change of mutations) {
      const from = direction === "undo" ? change.after : change.before, to = direction === "undo" ? change.before : change.after;
      const current = result.get(change.id);
      if (!to) {
        // Remember later generation results when undoing an inserted node.
        if (current) { if (direction === "undo") change.after = current; else change.before = current; }
        result.delete(change.id);
      } else if (!from) result.set(change.id, { ...to });
      else if (current) result.set(change.id, merge(current, from, to));
    }
    return [...result.values()];
  };
  const nodes = apply(graph.nodes, entry.nodes, (current, from, to) => ({
    ...current,
    ...mergeFields(nodeValue(current), nodeValue(from), nodeValue(to)),
    // Restore only fields edited by the user. Task patches remain current.
    data: { ...current.data, ...mergeFields(userData(current.data), userData(from.data), userData(to.data)) } as CanvasFlowNode['data'],
    dragging: false,
  }));
  const ids = new Set(nodes.map(node => node.id));
  const edges = apply(graph.edges, entry.edges, (current, from, to) => ({ ...current, ...mergeFields(edgeValue(current), edgeValue(from), edgeValue(to)) })).filter(edge => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges };
}
