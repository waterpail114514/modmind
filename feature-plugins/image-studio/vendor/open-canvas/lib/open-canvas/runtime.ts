import {
  normalizeCanvasNodeData,
  type CanvasDocumentRecord,
  type CanvasNodeMedia,
  type CanvasNodePatch,
  type SerializedCanvasGraph,
} from "../../components/open-canvas/upstream/shared/lib/canvas/types";
import { buildCanvasNodeTaskDescriptor } from "../../components/open-canvas/upstream/shared/lib/canvas/execution";
import { useCanvasStore } from "../../components/open-canvas/upstream/shared/stores/canvas-store";
import { setCanvasAccount, canvasStorageKey } from "./identity";
import { CanvasDatabase, CanvasRevisionConflict, type LocalCanvasRun, type LocalCanvasTemplate } from "./storage";
import { loadCanvasSettings, saveCanvasSettings, type CanvasProviderSettings } from "./settings";
import { setCanvasCatalog } from "./catalog";
import { blobDataUrl, generateCanvasImages, imageBlob } from "./transport";

type Job = { run: LocalCanvasRun; controller: AbortController; settings: CanvasProviderSettings; graph: SerializedCanvasGraph };
type QueueSummary = { id: string; title: string; status: string; error: string | null };
const finalStatus = (status: string) => ["success", "failed", "canceled"].includes(status);
const reply = (data: object) => Response.json({ code: 0, data });
let activeRuntime: OpenCanvasRuntime | null = null;

export class OpenCanvasRuntime {
  readonly database: CanvasDatabase;
  readonly ownerId = crypto.randomUUID();
  readonly ready: Promise<void>;
  settings: CanvasProviderSettings;
  private jobs: Job[] = [];
  private running = false;
  private disposed = false;
  private releaseLifetime?: () => void;
  private listeners = new Set<() => void>();
  private summaries: QueueSummary[] = [];

  constructor(readonly userId: string) {
    setCanvasAccount(userId);
    this.database = new CanvasDatabase(userId);
    this.settings = loadCanvasSettings(userId);
    setCanvasCatalog(this.settings);
    this.ready = this.initialize();
  }

  private async initialize() {
    const locks = navigator.locks;
    if (locks) {
      await new Promise<void>((resolve, reject) => {
        void locks.request(`modmind-open-canvas-owner:${this.ownerId}`, () => new Promise<void>(release => {
          this.releaseLifetime = release;
          if (this.disposed) release();
          resolve();
        })).catch(reject);
      });
    }
    if (this.disposed) return;
    const activeLocks = locks ? new Set((await locks.query()).held?.map(lock => lock.name)) : null;
    for (const run of await this.database.list<LocalCanvasRun>("runs")) {
      if (finalStatus(run.status)) continue;
      if (activeLocks?.has(`modmind-open-canvas-owner:${run.ownerId}`)) continue;
      if (!activeLocks && Date.now() - Date.parse(run.createdAt ?? "") < 190000) continue;
      run.status = "canceled";
      run.errorMessage = "上次生成的页面已关闭，结果未能保存。上游可能仍在处理，请先确认任务情况后再手动生成";
      run.finishedAt = new Date().toISOString();
      run.nodePatch = { nodeId: run.nodeId, status: "error", errorMessage: run.errorMessage };
      await this.database.completeRun(run);
    }
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.summaries;
  private emit() {
    this.summaries = this.jobs.map(job => ({ id: job.run.id, title: job.run.prompt.slice(0, 45) || "画布任务", status: job.run.status, error: job.run.errorMessage }));
    this.listeners.forEach(listener => listener());
  }

  updateSettings(settings: CanvasProviderSettings) {
    saveCanvasSettings(settings);
    this.settings = structuredClone(settings);
    setCanvasCatalog(this.settings);
    this.emit();
  }

  async listCanvases() {
    await this.ready;
    return (await this.database.list<CanvasDocumentRecord>("canvases")).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async flushStudio() {
    const state = useCanvasStore.getState();
    if (!state.canvasId || !state.isHydrated || !state.isDirty) return;
    if (state.conflictDetected) throw new Error("画布存在版本冲突，请先在编辑器中加载最新版本");
    const graph = state.getGraph();
    const canvas = await this.database.saveGraph(state.canvasId, state.revision, graph);
    if (useCanvasStore.getState().canvasId !== state.canvasId) return;
    useCanvasStore.getState().finishSave({ revision: canvas.revision, updatedAt: canvas.updatedAt, savedGraphString: JSON.stringify(graph) });
  }

  async listAssets() {
    const media = new Map<string, CanvasNodeMedia & { id: string; type: "image" | "video"; title: string }>();
    for (const canvas of await this.listCanvases()) {
      for (const node of canvas.graph.nodes) {
        const data = normalizeCanvasNodeData(node.type, node.data);
        const items = data.nodeType === "image" ? [data.image, ...data.imageOutputs] : data.nodeType === "video" ? [data.video, ...data.videoHistory] : [];
        for (const item of items) if (item?.url && !media.has(item.url)) media.set(item.url, { ...item, id: `${canvas.id}:${node.id}:${media.size}`, type: data.nodeType as "image" | "video", title: data.title });
      }
    }
    return [...media.values()];
  }

  async enqueue(canvasId: string, nodeId: string, revision: number) {
    if (this.disposed) throw new Error("画布已关闭，请刷新页面");
    const canvas = await this.database.get<CanvasDocumentRecord>("canvases", canvasId);
    const node = canvas?.graph.nodes.find(item => item.id === nodeId);
    if (!canvas || !node) throw new Error("画布节点不存在");
    const data = normalizeCanvasNodeData(node.type, node.data);
    if (node.type === "note") throw new Error("便签仅用于说明，无需生成");
    if (node.type === "audio") throw new Error("音频节点支持上传与连线，当前未接入音频生成 API");
    const descriptor = buildCanvasNodeTaskDescriptor(canvas.graph, nodeId);
    if (!("kind" in descriptor)) throw new Error(descriptor.message);
    const now = new Date().toISOString();
    const run: LocalCanvasRun = {
      id: crypto.randomUUID(), ownerId: this.ownerId, canvasId, userId: this.userId, nodeId, nodeType: node.type,
      status: "pending", triggerType: "manual", scene: descriptor.scene, provider: this.settings.route, model: data.model,
      prompt: descriptor.prompt, aiTaskId: null, costCredits: 0, inputSummary: null, requestPayload: null, responsePayload: null,
      outputAsset: null, errorCode: null, errorMessage: null, finishedAt: null, createdAt: now, updatedAt: now,
    };
    run.nodePatch = { nodeId, status: "queued", errorMessage: null, lastRunId: run.id };
    const updated = await this.database.enqueueRun(run, revision);
    this.jobs = this.jobs.filter(job => !finalStatus(job.run.status)).slice(-50);
    this.jobs.push({ run, controller: new AbortController(), settings: structuredClone(this.settings), graph: canvas.graph });
    this.emit();
    window.setTimeout(() => { void this.pump(); }, 0);
    return { run, nodePatch: run.nodePatch, revision: updated.revision };
  }

  private async pump() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        if (job.run.status !== "pending") continue;
        const execute = () => this.execute(job);
        // A single account's tabs share the same execution slot.
        if (navigator.locks) {
          try { await navigator.locks.request(`modmind-open-canvas-execute:${this.userId}`, { signal: job.controller.signal }, execute); }
          catch { if (!finalStatus(job.run.status)) await this.finishJob(job, "canceled", "任务已取消"); }
        } else await execute();
      }
    } finally { this.running = false; this.emit(); }
  }

  private async execute(job: Job) {
    if (job.controller.signal.aborted || this.disposed || job.run.status !== "pending") return;
    const run = job.run;
    run.status = "running";
    try {
      await this.database.put("runs", run);
      this.emit();
      const canvas = await this.database.get<CanvasDocumentRecord>("canvases", run.canvasId);
      const node = job.graph.nodes.find(item => item.id === run.nodeId);
      if (!canvas || !node) throw new Error("画布节点已删除");
      const data = normalizeCanvasNodeData(node.type, node.data);
      for (const edge of job.graph.edges.filter(item => item.target === node.id)) {
        const source = job.graph.nodes.find(item => item.id === edge.source);
        if (!source) continue;
        const sourceData = normalizeCanvasNodeData(source.type, source.data);
        if (sourceData.nodeType === "image" && !sourceData.image?.url) throw new Error(`上游「${sourceData.title}」尚无图片，请先上传或生成参考图`);
      }
      const descriptor = buildCanvasNodeTaskDescriptor(job.graph, node.id);
      if (!("kind" in descriptor)) throw new Error(descriptor.message);
      const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(3_600_000)]);
      let patch: CanvasNodePatch;
      const references = [...descriptor.inputs.imageInputs, ...descriptor.inputs.styleReferenceInputs, ...descriptor.inputs.omniReferenceInputs].map(item => item.url);
      if (data.nodeType === "image") {
        const result = await generateCanvasImages({ settings: job.settings, node: data, prompt: descriptor.prompt, references, signal });
        const outputs: CanvasNodeMedia[] = result.assets.map(asset => ({ url: asset.dataUrl, assetId:asset.id, source:"generated", mimeType:"image/png" }));
        if (!outputs.length) throw new Error(result.error || "图片服务没有返回结果");
        patch = {nodeId:node.id, image:outputs[0], imageOutputs:outputs, selectedImageIndex:0};
        run.outputAsset = outputs[0]; run.costCredits = result.credits;
        await this.finishJob(job, result.error ? "failed" : "success", result.error ?? null, {...patch, status:result.error ? "error" : "success", errorMessage:result.error ?? null, lastCompletedAt:new Date().toISOString(), lastRunId:run.id, lastScene:descriptor.scene});
        return;
      } else throw new Error("此画布仅提供图片生成，文本节点可用作提示词输入");

    } catch (error) {
      const canceled = job.controller.signal.aborted;
      const message = canceled ? "已取消等待。已提交的上游任务可能仍在处理，请确认后再重新生成" : error instanceof Error ? error.name === "TimeoutError" ? "等待图片超时，上游可能仍在生成，请勿立即重复提交" : error.message : "生成失败，请检查线路后重试";
      await this.finishJob(job, canceled ? "canceled" : "failed", message);
    }
  }

  private async finishJob(job: Job, status: LocalCanvasRun["status"], error: string | null, patch?: CanvasNodePatch) {
    const run = job.run;
    const finishedAt = new Date().toISOString();
    const completed: LocalCanvasRun = { ...run, status, errorMessage: error, finishedAt, updatedAt: finishedAt,
      nodePatch: patch ?? { nodeId: run.nodeId, status: "error", errorMessage: error, lastRunId: run.id } };
    // A terminal status must only become visible with its committed canvas revision.
    try { await this.database.completeRun(completed); }
    catch (failure) {
      completed.storageError = failure instanceof Error ? failure.message : "保存失败，请先下载结果，暂勿刷新页面";
      if (!this.disposed) window.dispatchEvent(new CustomEvent("modmind-open-canvas-save-error", { detail: { userId: this.userId, message: completed.storageError } }));
    }
    Object.assign(run, completed);
    this.emit();
  }

  async cancel(runId: string) {
    const job = this.jobs.find(item => item.run.id === runId);
    if (!job || finalStatus(job.run.status)) return;
    const queued = job.run.status === "pending";
    if (!queued) throw new Error("本批次已提交，请等待结果；可取消尚未开始的排队任务");
    job.controller.abort();
    if (queued) await this.finishJob(job, "canceled", "排队任务已取消，未提交生图请求");
  }

  hasActiveJobs() { return this.jobs.some(job => !finalStatus(job.run.status)); }

  dispose() {
    this.disposed = true;
    this.jobs.filter(job => !finalStatus(job.run.status)).forEach(job => job.controller.abort());
    this.releaseLifetime?.();
    if (activeRuntime === this) activeRuntime = null;
  }

  async request(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    await this.ready;
    const origin = window.location.origin === 'null' ? 'https://modmind.local' : window.location.origin;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = init.method || "GET";
    if (url.pathname === "/api/proxy/file") return new Response(await imageBlob(url.searchParams.get("url") ?? "", init.signal ?? undefined));
    if (url.pathname.includes("/uploads/") || url.pathname === "/api/storage/upload-audio") {
      if (!(init.body instanceof FormData)) throw new Error("没有找到上传文件");
      const file = init.body.get("file") ?? init.body.get("files");
      if (!(file instanceof Blob) || !file.size) throw new Error("请选择有效的文件");
      const isAudio = url.pathname.endsWith("upload-audio");
      const isVideo = url.pathname.endsWith("videos");
      const allowed = isAudio ? /^(audio\/(mpeg|mp3|wav|x-wav|wave))$/ : isVideo ? /^video\/(mp4|quicktime)$/ : /^image\/(png|jpeg|webp|gif|avif)$/;
      const limit = isAudio || isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
      if (!allowed.test(file.type) || file.size > limit) throw new Error(`不支持此文件格式，或文件超过 ${limit / 1024 / 1024} MB`);
      const dataUrl = await blobDataUrl(file);
      return reply(isAudio ? { urls: [dataUrl] } : { media: { url: dataUrl, source: "uploaded", mimeType: file.type, size: file.size, durationSec: Number(init.body.get("durationSec")) || null } });
    }
    if (parts[0] !== "api" || parts[1] !== "canvas" || !parts[2]) {
      if (url.protocol === "data:" || url.protocol === "blob:") return fetch(input, init);
      throw new Error("画布请求地址不受支持");
    }
    const canvasId = parts[2];
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (parts[3] === "graph" && method === "PUT") {
      try {
        const canvas = await this.database.saveGraph(canvasId, body.revision, body.graph as SerializedCanvasGraph);
        return reply({ revision: canvas.revision, updatedAt: canvas.updatedAt });
      } catch (error) { if (error instanceof CanvasRevisionConflict) return Response.json({ code: 409, message: "revision_conflict" }); throw error; }
    }
    if (parts[3] === "nodes" && parts[5] === "execute") {
      try { return reply(await this.enqueue(canvasId, parts[4], body.revision)); }
      catch (error) { return Response.json({ code: 400, message: error instanceof Error ? error.message : "启动任务失败" }); }
    }
    if (parts[3] === "runs" && parts[4]) {
      const currentRun = this.jobs.find(job => job.run.id === parts[4])?.run ?? await this.database.get<LocalCanvasRun>("runs", parts[4]);
      if (!currentRun || currentRun.canvasId !== canvasId) throw new Error("任务不存在");
      // Completion can change the live job while the revision read is pending.
      const run = structuredClone(currentRun);
      const canvas = await this.database.get<CanvasDocumentRecord>("canvases", canvasId);
      return reply({ run, nodePatch: run.nodePatch, revision: run.storageError ? null : canvas?.revision, storageError: run.storageError });
    }
    if (parts[3] === "template" && method === "POST") {
      const template: LocalCanvasTemplate = { id: crypto.randomUUID(), title: body.title || "我的模板", graph: body.graph, updatedAt: new Date().toISOString() };
      await this.database.put("templates", template);
      return reply({ template });
    }
    if (method === "PATCH") {
      const canvas = await this.database.mutateCanvas(canvasId, current => ({ ...current, title: String(body.title || "未命名画布").slice(0, 100), updatedAt: new Date().toISOString() }));
      return reply({ canvas });
    }
    const canvas = await this.database.get<CanvasDocumentRecord>("canvases", canvasId);
    if (!canvas) throw new Error("画布不存在或已删除");
    return reply({ canvas });
  }
}

export function initializeOpenCanvas(userId: string) {
  if (!activeRuntime || activeRuntime.userId !== userId) {
    activeRuntime?.dispose();
    activeRuntime = new OpenCanvasRuntime(userId);
  }
  return activeRuntime;
}

export function getOpenCanvasRuntime() {
  if (!activeRuntime) throw new Error("画布尚未初始化");
  return activeRuntime;
}

export function canvasFetch(input: RequestInfo | URL, init?: RequestInit) { return getOpenCanvasRuntime().request(input, init); }
export function activeCanvasKey() { return canvasStorageKey("active-document"); }
