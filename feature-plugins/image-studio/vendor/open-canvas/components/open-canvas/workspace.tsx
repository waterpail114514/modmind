"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, FilePlus2, FolderOpen, LayoutTemplate, LoaderCircle, Settings2, Upload, X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { CanvasStudioShell } from "./upstream/shared/blocks/canvas/canvas-studio-shell";
import { AppProvider } from "./upstream/shared/contexts/app";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./upstream/shared/components/ui/dialog";
import { useCanvasStore } from "./upstream/shared/stores/canvas-store";
import { writeCanvasModelPreferences } from "./upstream/shared/lib/model-preferences";
import { initializeOpenCanvas, activeCanvasKey, type OpenCanvasRuntime } from "../../lib/open-canvas/runtime";
import { parseCanvasDocument, exportCanvasDocument, builtinCanvasTemplates } from "../../lib/open-canvas/document";
import { IMAGE_ROUTE_LABELS, type CanvasProviderSettings } from "../../lib/open-canvas/settings";
import type { LocalCanvasTemplate } from "../../lib/open-canvas/storage";
import type { CanvasDocumentRecord } from "./upstream/shared/lib/canvas/types";
import { tracedImageStudio } from "../../../../src/renderer/src/lib/imageStudioTrace";
import { legacyImageCanvases } from "../../../../src/renderer/src/lib/imageCanvasMigration";
import { MediaLibrary } from "./media-library";
import { canvasTheme, useCanvasPreferences } from "./preferences";
import { useConfirmDialog } from '../../../../../../src/renderer/src/components/InteractionDialogs';

type WorkspaceState = { runtime: OpenCanvasRuntime; canvas: CanvasDocumentRecord; canvases: CanvasDocumentRecord[] };
const emptyQueue: ReturnType<OpenCanvasRuntime["snapshot"]> = [];
const noSubscribe = () => () => {};
const noSnapshot = () => emptyQueue;

function errorText(error: unknown) { return error instanceof Error ? error.message : "操作失败，请重试"; }

export default function OpenCanvasWorkspace({ userId, visible, darkMode, onSettings }: { userId: string; visible: boolean; darkMode: boolean; onSettings: () => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [failure, setFailure] = useState("");
  const [attempt,setAttempt]=useState(0);
  const [migrationError,setMigrationError]=useState('');
  const {confirm,dialog}=useConfirmDialog();
  const [connectionError, setConnectionError] = useState("");
  const [mediaLibrary, setMediaLibrary] = useState<{ kind: "assets" | "history"; canvasId: string; position?: { x: number; y: number } } | null>(null);
  const [preferences] = useCanvasPreferences(userId);
  const theme = canvasTheme(preferences);

  const [library, setLibrary] = useState<"canvases" | "templates" | null>(null);
  const [templates, setTemplates] = useState<LocalCanvasTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const queue = useSyncExternalStore(workspace?.runtime.subscribe ?? noSubscribe, workspace?.runtime.snapshot ?? noSnapshot, noSnapshot);
  const pending = queue.filter(run => run.status === "pending" || run.status === "running");

  useEffect(() => {
    let canceled = false;
    const runtime = initializeOpenCanvas(userId);
    const pageHide = () => runtime.dispose();
    window.addEventListener("pagehide", pageHide);
    void (async () => {
      await runtime.ready;
      let canvases = await runtime.listCanvases();
      if (canceled) return;
      if (!canvases.length) {
        let legacy: Awaited<ReturnType<typeof legacyImageCanvases>> = [];
        try { legacy = await legacyImageCanvases(); }
        catch { if(!canceled)setMigrationError('旧工作流未能转换，原存档仍保留；可继续使用新画布'); }
        for (const item of legacy) canvases.push(await runtime.database.createCanvas(item.title, item.graph));
        if (!canvases.length) canvases = [await runtime.database.createCanvas()];
      }
      if (canceled) return;
      const savedId = localStorage.getItem(activeCanvasKey());
      const canvas = canvases.find(item => item.id === savedId) ?? canvases[0];
      setWorkspace({ runtime, canvas, canvases });
      writeCanvasModelPreferences("image", runtime.settings.models[runtime.settings.route], {});
    })().catch(error => { if (!canceled) setFailure(errorText(error)); });
    return () => { canceled = true; window.removeEventListener("pagehide", pageHide); runtime.dispose(); };
  }, [userId,attempt]);

  const refreshLibrary = useCallback(async (kind: "canvases" | "templates") => {
    if (!workspace) return;
    try {
      await workspace.runtime.flushStudio();
      const canvases = await workspace.runtime.listCanvases();
      setWorkspace(current => current ? { ...current, canvases } : current);
      setTemplates(await workspace.runtime.database.list<LocalCanvasTemplate>("templates"));
      setLibrary(kind);
    } catch (error) { toast.error(errorText(error)); }
  }, [workspace]);

  useEffect(() => {
    const open = () => { void refreshLibrary("canvases"); };
    const media = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const kind = typeof detail === "string" ? detail : detail?.kind;
      const canvasId = detail?.canvasId ?? useCanvasStore.getState().canvasId;
      if ((kind === "assets" || kind === "history") && canvasId) setMediaLibrary({ kind, canvasId, position: detail?.position });
    };
    const saveError = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; message: string }>).detail;
      if (detail.userId === userId) toast.error(detail.message, { duration: 15000 });
    };
    window.addEventListener("modmind-open-canvas-list", open);
    window.addEventListener("modmind-open-canvas-media", media);
    window.addEventListener("modmind-open-canvas-save-error", saveError);
    return () => { window.removeEventListener("modmind-open-canvas-list", open); window.removeEventListener("modmind-open-canvas-media", media); window.removeEventListener("modmind-open-canvas-save-error", saveError); };
  }, [refreshLibrary, userId]);

  async function openCanvas(canvas: CanvasDocumentRecord) {
    if (!workspace || busy) return;
    try {
      setBusy(true);
      await workspace.runtime.flushStudio();
      const latest = await workspace.runtime.database.get<CanvasDocumentRecord>("canvases", canvas.id);
      if (!latest) throw new Error("画布已删除");
      localStorage.setItem(activeCanvasKey(), latest.id);
      setWorkspace(current => current ? { ...current, canvas: latest } : current);
      setLibrary(null);
    } catch (error) { toast.error(errorText(error)); }
    finally { setBusy(false); }
  }

  async function createCanvas(template?: { title: string; graph: CanvasDocumentRecord["graph"] }) {
    if (!workspace || busy) return;
    try {
      setBusy(true);
      await workspace.runtime.flushStudio();
      const canvas = await workspace.runtime.database.createCanvas(template?.title, template ? parseCanvasDocument({ title: template.title, graph: template.graph }).graph : undefined);
      localStorage.setItem(activeCanvasKey(), canvas.id);
      setWorkspace({ ...workspace, canvas, canvases: [canvas, ...workspace.canvases] });
      setLibrary(null);
    } catch (error) { toast.error(errorText(error)); }
    finally { setBusy(false); }
  }

  async function exportCanvas() {
    if (!workspace) return;
    try {
      try { await workspace.runtime.flushStudio(); }
      catch { toast.warning("本地保存暂时失败，正在导出当前编辑内容作为备份"); }
      const current = await workspace.runtime.database.get<CanvasDocumentRecord>("canvases", workspace.canvas.id);
      if (!current) throw new Error("画布不存在");
      const state = useCanvasStore.getState();
      const data = exportCanvasDocument(current.title, state.canvasId === current.id ? state.getGraph() : current.graph);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `${current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "画布"}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { toast.error(errorText(error)); }
  }

  useEffect(() => {
    if (!workspace || !visible) return;
    let canceled = false;
    void (async () => {
      const saved = await tracedImageStudio().getSettings();
      let models: string[] = saved.model ? [saved.model] : [];
      try { models = (await tracedImageStudio().capabilities()).models; if (!canceled) setConnectionError(''); }
      catch(error) { if (!canceled) setConnectionError(errorText(error)); }
      if(canceled) return;
      const route = saved.hasStoredKey ? 'custom' : 'official';
      const model = saved.model || models[0] || '';
      const settings = {...workspace.runtime.settings, route:route as 'custom'|'official', models:{official:model,ls:model,custom:model}, catalogs:{official:models,ls:models,custom:models}};
      workspace.runtime.updateSettings(settings);
      writeCanvasModelPreferences('image',model,{});
      const store=useCanvasStore.getState();
      for(const node of store.nodes) if(node.data.nodeType==='image' && (!models.includes(node.data.model) || route==='official')) store.updateNodeData(node.id,{model});
      setWorkspace(current=>current?{...current}:current);
    })().catch(error=>{if(!canceled) setConnectionError(errorText(error));});
    return()=>{canceled=true;};
  },[workspace?.runtime,visible]);

  if (failure) return <div className="oc-loading"><p role="alert">{failure}</p><button className="oc-button" onClick={() => {setFailure('');setWorkspace(null);setAttempt(value=>value+1);}}>重新打开画布</button></div>;
  if (!workspace) return <div className="oc-loading" role="status"><LoaderCircle className="animate-spin" size={24} /><p>正在打开画布…</p></div>;
  return <AppProvider userId={userId}>
    <div className="open-canvas-root image-canvas-scope" data-canvas-version="new" data-testid="open-canvas-workspace" data-oc-theme={darkMode ? "dark" : "light"}>
      <div className="oc-workspace-bar">
        <details className="oc-file-menu"><summary className="oc-button" aria-label="画布文件菜单"><FolderOpen size={14} /><span>文件</span></summary><div className="oc-file-actions" onClick={event => event.currentTarget.closest("details")?.removeAttribute("open")}>
          <button className="oc-button" onClick={() => void refreshLibrary("canvases")}><FolderOpen size={15} /><span>我的画布</span></button>
          <button className="oc-button" disabled={busy} onClick={() => void createCanvas()}><FilePlus2 size={15} /><span>新建</span></button>
          <button className="oc-button" onClick={() => void refreshLibrary("templates")}><LayoutTemplate size={15} /><span>模板</span></button>
          <button className="oc-button" onClick={() => importInput.current?.click()}><Upload size={15} /><span>导入</span></button>
          <button className="oc-button" onClick={() => void exportCanvas()}><Download size={15} /><span>导出</span></button>
        </div></details>
        <button className="oc-button oc-provider-button" aria-label="图像服务设置" onClick={onSettings}><Settings2 size={15} /><span>{IMAGE_ROUTE_LABELS[workspace.runtime.settings.route]}</span></button>
      </div>
      <div className="oc-queue" aria-live="polite" data-active={pending.length > 0}>
        <span>{pending.length ? <><LoaderCircle className="animate-spin" size={14} />{pending.some(run => run.status === "running") ? "正在生成" : "等待执行"} · {pending.length} 个任务</> : (connectionError || migrationError) ? <><span role="status">{connectionError || migrationError}</span>{connectionError&&<button className="oc-button" onClick={onSettings}>检查设置</button>}</> : ""}</span>
        {pending.filter(run=>run.status === "pending").map(run => <button key={run.id} className="oc-button" title={run.title} onClick={() => void workspace.runtime.cancel(run.id)}><X size={13} />{run.status === "running" ? "取消生成" : "取消排队"}</button>)}
      </div>
      <div className="oc-editor"><CanvasStudioShell key={workspace.canvas.id} initialCanvas={workspace.canvas} darkMode={darkMode} /></div>
      <input ref={importInput} data-testid="open-canvas-import" type="file" accept="application/json,.json" className="hidden" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        if (file.size > 64 * 1024 * 1024) { toast.error("画布文件超过 64 MB"); return; }
        void file.text().then(text => parseCanvasDocument(JSON.parse(text), file.name.replace(/\.json$/i, ""))).then(parsed => createCanvas(parsed)).catch(error => toast.error(errorText(error)));
      }} />
      {mediaLibrary && <MediaLibrary runtime={workspace.runtime} kind={mediaLibrary.kind} canvasId={mediaLibrary.canvasId} position={mediaLibrary.position} onClose={() => setMediaLibrary(null)} />}
      {library && <Dialog open onOpenChange={open => { if (!open) setLibrary(null); }}>
        <DialogContent className="open-canvas-modal max-h-[85dvh] overflow-y-auto border-white/15 bg-[#141619] text-white sm:max-w-2xl">
          <DialogTitle>{library === "canvases" ? "我的画布" : "工作流模板"}</DialogTitle>
          <DialogDescription className="text-zinc-400">画布保存在本机，可导出 JSON 备份。</DialogDescription>
          <div className="oc-library">
            {library === "canvases" ? workspace.canvases.map(canvas => <div key={canvas.id} className="oc-library-item">
              <button disabled={busy} onClick={() => void openCanvas(canvas)}><strong>{canvas.title}</strong><span>{canvas.preview.nodeCount} 个节点 · {canvas.id === workspace.canvas.id ? "当前画布" : "打开画布"}</span></button>
              <button className="oc-button" aria-label={`删除画布 ${canvas.title}`} onClick={async () => {
                if (workspace.runtime.hasActiveJobs()) { toast.error("请先完成或取消生成任务后再删除画布"); return; }
                if (!await confirm({title:'删除画布？',message:`“${canvas.title}”及其画布图片将从本机移除。`,confirmLabel:'删除画布',tone:'danger'})) return;
                void (async () => {
                  await workspace.runtime.database.deleteCanvas(canvas.id);
                  const canvases = await workspace.runtime.listCanvases();
                  if (canvas.id === workspace.canvas.id) {
                    const next = canvases[0] ?? await workspace.runtime.database.createCanvas();
                    localStorage.setItem(activeCanvasKey(), next.id);
                    setWorkspace({ ...workspace, canvas: next, canvases: canvases.length ? canvases : [next] });
                  } else setWorkspace({ ...workspace, canvases });
                })().catch(error => toast.error(errorText(error)));
              }}>删除</button>
            </div>) : [...builtinCanvasTemplates(), ...templates].map(template => <button className="oc-template" key={template.id} disabled={busy} onClick={() => void createCanvas(template)}><LayoutTemplate size={22} /><strong>{template.title}</strong><span>{template.graph.nodes.length} 个节点 · 创建副本</span></button>)}
          </div>
        </DialogContent>
      </Dialog>}
      {dialog}
      <Toaster className="image-canvas-scope" theme={darkMode ? "dark" : "light"} position="bottom-left" closeButton />
    </div>
  </AppProvider>;
}
