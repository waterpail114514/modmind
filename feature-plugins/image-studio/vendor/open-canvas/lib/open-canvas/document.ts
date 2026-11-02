import {
  createDefaultCanvasNodeData,
  createEmptyCanvasGraph,
  normalizeCanvasGraph,
  type SerializedCanvasGraph,
} from "../../components/open-canvas/upstream/shared/lib/canvas/types";
import { validateCanvasGraph } from "../../components/open-canvas/upstream/shared/lib/canvas/validation";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }

export function parseCanvasDocument(value: unknown, fallbackTitle = "导入的画布"): { title: string; graph: SerializedCanvasGraph } {
  if (!record(value)) throw new Error("文件不是有效的画布 JSON");
  let graph: SerializedCanvasGraph;
  const candidate = record(value.graph) ? value.graph : record(value.canvas) && record(value.canvas.graph) ? value.canvas.graph : value;
  if (Array.isArray(candidate.nodes) && Array.isArray(candidate.edges) && record(candidate.viewport)) {
    const validation = validateCanvasGraph(candidate as unknown as SerializedCanvasGraph);
    if (!validation.ok) throw new Error(`画布格式不正确：${validation.message}`);
    graph = normalizeCanvasGraph(candidate as unknown as SerializedCanvasGraph);
  } else throw new Error("不支持的画布格式。请导入新版 Open Canvas JSON");
  // Imported task IDs belong to another browser session and must never resume or submit generation.
  graph.nodes = graph.nodes.map(node => ({ ...node, data: { ...node.data, status: ["running", "queued"].includes(String(node.data?.status)) ? "idle" : node.data?.status ?? "idle", lastRunId: null } }));
  const validation = validateCanvasGraph(graph);
  if (!validation.ok) throw new Error(`画布无法导入：${validation.message}`);
  return { title: typeof value.title === "string" ? value.title.slice(0, 100) : fallbackTitle, graph };
}

export function exportCanvasDocument(title: string, graph: SerializedCanvasGraph) {
  return { format: "open-canvas-document-v1", exportedAt: new Date().toISOString(), title, graph: normalizeCanvasGraph(graph) };
}

export function builtinCanvasTemplates() {
  const create = (title: string, prompt: string, withReference: boolean) => {
    const graph = createEmptyCanvasGraph();
    graph.viewport = { x: 70, y: 90, zoom: .85 };
    graph.nodes.push({ id: "image-output", type: "image", position: { x: withReference ? 440 : 80, y: 40 }, data: { ...createDefaultCanvasNodeData("image", "zh"), title: "创作图片", prompt } });
    if (withReference) {
      graph.nodes.unshift({ id: "image-reference", type: "image", position: { x: 20, y: 40 }, data: { ...createDefaultCanvasNodeData("image", "zh"), title: "上传参考图", inputMode: "upload" } });
      graph.edges.push({ id: "reference-output", source: "image-reference", target: "image-output", sourceHandle: "right", targetHandle: "left", type: "default" });
    }
    return { id: `builtin-${withReference ? "reference" : "image"}`, title, graph };
  };
  return [create("灵感生图", "描绘一间阳光透过绿植洒入的设计工作室，自然光，精致细节，温暖的胶片色调", false), create("参考图改绘", "保留参考图的主体与构图，改绘为细腻的水彩插画", true)];
}
