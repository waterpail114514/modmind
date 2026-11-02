"use client";
/* eslint-disable @next/next/no-img-element -- Canvas assets are local media. */

import { useEffect, useState } from "react";
import { Check, Download, ImagePlus, LoaderCircle, Search } from "lucide-react";
import { toast } from "sonner";
import type { OpenCanvasRuntime } from "../../lib/open-canvas/runtime";
import type { LocalCanvasRun } from "../../lib/open-canvas/storage";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./upstream/shared/components/ui/dialog";
import { useCanvasStore } from "./upstream/shared/stores/canvas-store";
import type { CanvasNodeMedia } from "./upstream/shared/lib/canvas/types";

export function MediaLibrary({ runtime, kind, canvasId, position, onClose }: { runtime: OpenCanvasRuntime; kind: "assets" | "history"; canvasId: string; position?: { x: number; y: number }; onClose: () => void }) {
  const [assets, setAssets] = useState<Awaited<ReturnType<OpenCanvasRuntime["listAssets"]>>>([]);
  const [runs, setRuns] = useState<LocalCanvasRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void (async () => {
      await runtime.flushStudio();
      const [items, history] = await Promise.all([runtime.listAssets(), runtime.database.list<LocalCanvasRun>("runs")]);
      if (active) { setAssets(items); setRuns(history.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))); }
    })().catch(error => toast.error(error instanceof Error ? error.message : "读取素材失败")).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runtime]);
  function add(media: CanvasNodeMedia, title: string, type: "image" | "video" = "image", index = 0) {
    const store = useCanvasStore.getState();
    if (store.canvasId !== canvasId) { toast.error('画布已切换，请重新选择插入位置'); onClose(); return false; }
    const viewport = store.viewport;
    const origin = position ?? { x: (window.innerWidth / 2 - viewport.x) / viewport.zoom - 360, y: (window.innerHeight / 2 - viewport.y) / viewport.zoom - 210 };
    const result = store.addNode(type, { x: origin.x + index * 80, y: origin.y + index * 60 }, "zh");
    if (!result.ok) { toast.error(result.message); return false; }
    store.updateNodeData(result.nodeId, type === "image" ? { title, image: media, imageOutputs: [media], referenceImage: media, inputMode: "upload", status: "success" } : { title, video: media, videoHistory: [media], inputMode: "upload", status: "success" });
    return true;
  }
  const visible = assets.filter(asset => (type === 'all' || asset.type === type) && asset.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="open-canvas-modal oc-media-dialog border-white/15 bg-[#222] text-white sm:max-w-3xl"><DialogTitle>{kind === "assets" ? "资产管理" : "生成历史"}</DialogTitle><DialogDescription className="text-zinc-400">{kind === "assets" ? "当前账号保存在此浏览器中的素材。选择后插入画布。" : "查看此浏览器中的生成记录与结果。"}</DialogDescription>
    {kind === 'assets' && <div className="oc-media-filters"><label className="oc-search-input"><Search size={15} /><input aria-label="搜索素材名称" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索素材名称" /></label><select aria-label="素材类型" value={type} onChange={event => setType(event.target.value)}><option value="all">全部类型</option><option value="image">图片</option><option value="video">视频</option></select></div>}
    {loading ? <LoaderCircle className="animate-spin" /> : kind === "assets" ? <><div className="oc-media-grid">{visible.length ? visible.map(asset => <button key={asset.id} aria-pressed={selected.includes(asset.id)} onClick={() => setSelected(current => current.includes(asset.id) ? current.filter(id => id !== asset.id) : [...current, asset.id])}>{asset.type === "image" ? <img src={asset.url} alt={asset.title} /> : <video src={asset.url} preload="metadata" />}<span>{selected.includes(asset.id) && <Check size={13} />}{asset.title}</span></button>) : <p className="oc-help">{assets.length ? '没有匹配的素材。' : '还没有素材。拖入图片或生成第一张作品后，会显示在这里。'}</p>}</div><div className="oc-media-footer"><span>已选 {selected.length} 项</span><button className="oc-button oc-primary" disabled={!selected.length} onClick={() => {
      const store = useCanvasStore.getState(); store.beginHistory();
      try { selected.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is (typeof assets)[number] => !!asset).forEach((asset, index) => add(asset, asset.title, asset.type, index)); }
      finally { store.endHistory(); }
      onClose();
    }}>插入已选素材</button></div></> : <div className="oc-history-list">{runs.length ? runs.map(run => <article key={run.id}>
      {run.outputAsset?.url && run.nodeType === "image" ? <img src={run.outputAsset.url} alt="生成结果" /> : <div className="oc-history-placeholder"><ImagePlus size={22} /></div>}
      <div><strong>{run.prompt || "生成任务"}</strong><span>{({ success: "已完成", failed: "失败", canceled: "已取消", pending: "排队中", running: "生成中" })[run.status]} · {run.model} · {run.createdAt ? new Date(run.createdAt).toLocaleString("zh-CN") : ""}</span>{run.errorMessage && <p>{run.errorMessage}</p>}</div>
      {run.outputAsset?.url && (run.nodeType === "image" || run.nodeType === "video") && <button className="oc-button" onClick={() => { const store = useCanvasStore.getState(); store.beginHistory(); try { if (add(run.outputAsset!, run.prompt.slice(0, 30) || "生成结果", run.nodeType as "image" | "video")) onClose(); } finally { store.endHistory(); } }}>添加到画布</button>}
      {run.outputAsset?.url && <a className="oc-button" href={run.outputAsset.url} download={run.nodeType === "image" ? "canvas-image.png" : "canvas-video.mp4"} aria-label="下载生成结果"><Download size={14} /></a>}
    </article>) : <p className="oc-help">还没有生成记录。</p>}</div>}
  </DialogContent></Dialog>;
}
