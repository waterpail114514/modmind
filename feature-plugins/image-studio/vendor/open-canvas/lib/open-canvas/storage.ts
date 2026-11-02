import {
  createEmptyCanvasGraph,
  summarizeCanvasGraph,
  applyCanvasNodePatch,
  type CanvasDocumentRecord,
  type CanvasNodePatch,
  type CanvasNodeRunRecord,
  type SerializedCanvasGraph,
} from "../../components/open-canvas/upstream/shared/lib/canvas/types";
import { validateCanvasGraph } from "../../components/open-canvas/upstream/shared/lib/canvas/validation";

export type LocalCanvasRun = CanvasNodeRunRecord & { ownerId: string; nodePatch?: CanvasNodePatch; storageError?: string };
export type LocalCanvasTemplate = { id: string; title: string; graph: SerializedCanvasGraph; updatedAt: string };

export class CanvasRevisionConflict extends Error {
  constructor() { super("revision_conflict"); }
}

export class CanvasDatabase {
  private connection: Promise<IDBDatabase>;

  constructor(readonly userId: string) {
    this.connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(`modmind-open-canvas:${userId}`, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("canvases", { keyPath: "id" });
        request.result.createObjectStore("runs", { keyPath: "id" });
        request.result.createObjectStore("templates", { keyPath: "id" });
      };
      request.onerror = () => reject(new Error("无法打开本地画布存储，请允许此网站使用浏览器存储"));
      request.onblocked = () => reject(new Error("画布存储正在升级，请先关闭其他画布标签页"));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  async close() { (await this.connection).close(); }

  async get<T>(store: "canvases" | "runs" | "templates", id: string): Promise<T | undefined> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async list<T>(store: "canvases" | "runs" | "templates"): Promise<T[]> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  async put(store: "canvases" | "runs" | "templates", value: object): Promise<void> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("本地保存失败，可能是浏览器存储空间不足。请导出画布备份"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本地保存已中断"));
    });
  }

  async deleteCanvas(id: string): Promise<void> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["canvases", "runs"], "readwrite");
      transaction.objectStore("canvases").delete(id);
      const cursor = transaction.objectStore("runs").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        if ((current.value as LocalCanvasRun).canvasId === id) current.delete();
        current.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async createCanvas(title = "未命名画布", graph = createEmptyCanvasGraph()) {
    const validation = validateCanvasGraph(graph);
    if (!validation.ok) throw new Error(validation.message);
    const now = new Date().toISOString();
    const canvas: CanvasDocumentRecord = {
      id: crypto.randomUUID(), title: title.trim().slice(0, 100) || "未命名画布", status: "active", revision: 1,
      preview: summarizeCanvasGraph(graph), graph, createdAt: now, updatedAt: now, lastOpenedAt: now,
    };
    await this.put("canvases", canvas);
    return canvas;
  }

  // Reading and comparing the revision in the same write transaction also protects other tabs.
  async mutateCanvas(id: string, change: (canvas: CanvasDocumentRecord) => CanvasDocumentRecord): Promise<CanvasDocumentRecord> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("canvases", "readwrite");
      const store = transaction.objectStore("canvases");
      const request = store.get(id);
      let result: CanvasDocumentRecord;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          if (!request.result) throw new Error("画布不存在或已删除");
          result = change(request.result as CanvasDocumentRecord);
          store.put(result);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("保存画布失败"));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("保存画布已中断"));
    });
  }

  saveGraph(id: string, revision: number, graph: SerializedCanvasGraph) {
    const validation = validateCanvasGraph(graph);
    if (!validation.ok) throw new Error(validation.message);
    return this.mutateCanvas(id, canvas => {
      if (canvas.revision !== revision) throw new CanvasRevisionConflict();
      return { ...canvas, graph, preview: summarizeCanvasGraph(graph), revision: canvas.revision + 1, updatedAt: new Date().toISOString() };
    });
  }

  patchNode(id: string, patch: CanvasNodePatch) {
    return this.mutateCanvas(id, canvas => {
      const graph = applyCanvasNodePatch(canvas.graph, patch);
      if (!graph) throw new Error("画布节点不存在或已删除");
      return { ...canvas, graph, preview: summarizeCanvasGraph(graph), revision: canvas.revision + 1, updatedAt: new Date().toISOString() };
    });
  }

  async completeRun(run: LocalCanvasRun): Promise<void> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["canvases", "runs"], "readwrite");
      const canvases = transaction.objectStore("canvases");
      const request = canvases.get(run.canvasId);
      request.onsuccess = () => {
        try {
          const canvas = request.result as CanvasDocumentRecord | undefined;
          const graph = canvas && run.nodePatch ? applyCanvasNodePatch(canvas.graph, run.nodePatch) : null;
          if (canvas && graph) canvases.put({ ...canvas, graph, preview: summarizeCanvasGraph(graph), revision: canvas.revision + 1, updatedAt: new Date().toISOString() });
          transaction.objectStore("runs").put(run);
        } catch { transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error("生成结果未能保存到浏览器，可能是存储空间不足。请先下载图片或导出画布，暂勿刷新页面"));
    });
  }

  async enqueueRun(run: LocalCanvasRun, revision: number): Promise<CanvasDocumentRecord> {
    const db = await this.connection;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["canvases", "runs"], "readwrite");
      const canvases = transaction.objectStore("canvases");
      const request = canvases.get(run.canvasId);
      let result: CanvasDocumentRecord;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const canvas = request.result as CanvasDocumentRecord | undefined;
          if (!canvas) throw new Error("画布不存在或已删除");
          if (canvas.revision !== revision) throw new CanvasRevisionConflict();
          const existing = canvas.graph.nodes.find(node => node.id === run.nodeId);
          if (!existing) throw new Error("画布节点不存在或已删除");
          if (["queued", "running"].includes(String(existing.data?.status))) throw new Error("这个节点已有执行中的任务，请等待或取消该任务");
          const graph = applyCanvasNodePatch(canvas.graph, run.nodePatch!);
          if (!graph) throw new Error("画布节点不存在或已删除");
          result = { ...canvas, graph, preview: summarizeCanvasGraph(graph), revision: canvas.revision + 1, updatedAt: new Date().toISOString() };
          canvases.put(result);
          transaction.objectStore("runs").put(run);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  }
}
