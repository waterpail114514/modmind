"use client";
/* eslint-disable @next/next/no-img-element -- References are local browser media. */

import { useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, Maximize2, Minus, Plus, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import type { CanvasImageNodeData, CanvasNodeMedia } from "./upstream/shared/lib/canvas/types";
import { IMAGE_ACCEPT, MAX_IMAGE_SIZE_BYTES, uploadCanvasImage } from "./upstream/shared/blocks/canvas/canvas-media-control";
import { CanvasPopover } from "./canvas-popover";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./upstream/shared/components/ui/dialog";
import { canvasImageSize } from "../../lib/open-canvas/transport";
import ImagePresetFields from '../../../../src/renderer/src/components/ImagePresetFields';

type Reference = { id: string; url: string; title: string };

export function ImageComposer({ data, models, ratios, references, context, busy, canGenerate, onChange, onModelChange, onRemoveReference, onGenerate }: {
  data: CanvasImageNodeData;
  models: string[];
  ratios: string[];
  references: Reference[];
  context?: ReactNode;
  busy: boolean;
  canGenerate: boolean;
  onChange: (patch: Partial<CanvasImageNodeData>) => void;
  onModelChange: (model: string) => void;
  onRemoveReference: (id: string) => void;
  onGenerate: () => void;
}) {
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [uploading, setUploading] = useState(false);
  const [promptHeight, setPromptHeight] = useState(88);
  const resizeRef = useRef<{ pointer: number; y: number; height: number } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const own = data.referenceImage;
  const referenceCount = new Set([own?.url, ...references.map(item => item.url)].filter(Boolean)).size;
  const locked = busy || uploading;

  async function selectFile(file?: File) {
    if (!file) return;
    try {
      setUploading(true);
      if (!IMAGE_ACCEPT.split(",").includes(file.type) || !file.size) throw new Error("请选择 PNG、JPG、WebP 等有效图片");
      if (file.size > MAX_IMAGE_SIZE_BYTES) throw new Error("图片不能超过 10 MB");
      const media: CanvasNodeMedia = await uploadCanvasImage(file);
      onChange({ referenceImage: media, image: media, imageOutputs: [media], selectedImageIndex: 0, inputMode: "generate", status: "success", errorMessage: null });
    } catch (error) { toast.error(error instanceof Error ? error.message : "上传失败"); }
    finally { setUploading(false); }
  }

  return <div className="oc-image-composer nodrag nopan nowheel" data-expanded={expanded} onPointerDown={event => event.stopPropagation()}>
    <div className="oc-composer-top">
      <span>{referenceCount ? `参考图 ${referenceCount}` : ""}</span>
      <div><span>字号</span><button aria-label="缩小提示词字号" onClick={() => setFontSize(value => Math.max(12, value - 1))}><Minus size={12} /></button><span>{fontSize}</span><button aria-label="放大提示词字号" onClick={() => setFontSize(value => Math.min(24, value + 1))}><Plus size={12} /></button><button aria-label="放大编辑提示词" onClick={() => { setSettingsAnchor(null); setExpanded(true); }}><Maximize2 size={13} /></button></div>
    </div>
    {(own || references.length > 0) && <div className="oc-reference-strip" aria-label="本次使用的参考图">
      {own && <div className="oc-reference-thumb"><img src={own.url} alt="当前节点参考图" /><span>参考图</span><button aria-label="移除当前节点参考图" disabled={locked} onClick={() => onChange({ referenceImage: null })}><X size={11} /></button></div>}
      {references.map(item => <div className="oc-reference-thumb" key={item.id}><img src={item.url} alt={item.title} /><span>{item.title}</span><button aria-label={`移除参考图 ${item.title}`} disabled={locked} onClick={() => onRemoveReference(item.id)}><X size={11} /></button></div>)}
    </div>}
    {context}
    <textarea aria-label="图片提示词" placeholder={referenceCount ? "描述你想对参考图进行的修改…" : "描述要生成的图片内容"} style={{ fontSize, height: promptHeight }} value={data.prompt} onChange={event => onChange({ prompt: event.target.value })} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !locked && canGenerate) { event.preventDefault(); onGenerate(); }
    }} />
    <div className="oc-prompt-resize" role="separator" aria-label="调整提示词高度" aria-orientation="horizontal" aria-valuenow={promptHeight} aria-valuemin={64} aria-valuemax={360} tabIndex={0} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resizeRef.current = { pointer: event.pointerId, y: event.clientY, height: promptHeight }; }} onPointerMove={event => { if (resizeRef.current?.pointer === event.pointerId) setPromptHeight(Math.max(64, Math.min(360, resizeRef.current.height + event.clientY - resizeRef.current.y))); }} onPointerUp={event => { resizeRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resizeRef.current = null; }} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setPromptHeight(value => Math.max(64, Math.min(360, value + (event.key === 'ArrowDown' ? 16 : -16)))); } }}><i /></div>
    <div className="oc-composer-controls">
      <label className="oc-model-select"><select aria-label="图片模型" value={data.model} disabled={locked} onChange={event => onModelChange(event.target.value)}>{[...new Set([data.model, ...models])].filter(Boolean).map(model => <option key={model} value={model}>{model}</option>)}</select><ChevronDown size={12} /></label>
      <div className="oc-composer-spacer" />
      {data.image?.url && data.image.url !== own?.url && <button className="oc-use-image" disabled={locked} onClick={() => onChange({ referenceImage: data.image })}>使用当前图片</button>}
      <button className="oc-composer-icon" aria-label="上传参考图" title="上传参考图" disabled={locked} onClick={() => upload.current?.click()}>{uploading ? <LoaderCircle size={16} className="animate-spin" /> : <ImagePlus size={16} />}</button>
      <input ref={upload} type="file" accept={IMAGE_ACCEPT} data-testid="node-reference-upload" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void selectFile(file); }} />
      <div className="oc-image-settings-wrap">
        <button className="oc-image-settings-trigger" aria-label={`图像设置：${data.aspectRatio} · ${data.resolution}`} aria-expanded={!!settingsAnchor} onClick={event => { const anchor = event.currentTarget; setSettingsAnchor(value => value ? null : anchor); }}><SlidersHorizontal size={13} /><span>{data.aspectRatio} · {data.resolution}</span></button>
        {settingsAnchor && <CanvasPopover anchor={settingsAnchor} above className="oc-image-settings" role="dialog" label="图像设置" onClose={() => setSettingsAnchor(null)}>
          <div className="oc-settings-heading">图像设置<button aria-label="关闭图像设置" onClick={() => setSettingsAnchor(null)}><X size={14} /></button></div>
          <label className="oc-field">质量<select aria-label="生成质量" value={data.quality ?? "medium"} onChange={event => onChange({quality: event.target.value as CanvasImageNodeData["quality"]})}>{[["low","低"],["medium","中"],["high","高"],["auto","自动"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <ImagePresetFields data={{kind:'generate',title:data.title,subtitle:'',style:data.style,presetId:data.presetId,presetPrompt:data.presetPrompt}} onChange={patch=>onChange({presetId:patch.presetId,presetPrompt:patch.presetPrompt,style:patch.style})} />
          <span className="oc-settings-label">分辨率</span>
          <div className="oc-resolution-options">{["1K", "2K", "4K"].map(value => <button key={value} aria-pressed={data.resolution === value} onClick={() => onChange({ resolution: value })}>{value}{data.resolution === value && <Check size={12} />}</button>)}</div>
          <span className="oc-settings-label">宽高比</span>
          <div className="oc-ratio-options">{ratios.map(ratio => <button key={ratio} aria-pressed={data.aspectRatio === ratio} onClick={() => onChange({ aspectRatio: ratio })}><i style={{ aspectRatio: ratio === "auto" ? "1" : ratio.replace(":", "/") }} />{ratio === "auto" ? "自动" : ratio}</button>)}</div>
          <p className="oc-help oc-pixel-size">{data.aspectRatio} · {canvasImageSize(data) === 'auto' ? '自动尺寸' : canvasImageSize(data).replace('x', '×') + 'px'}</p>
        </CanvasPopover>}
      </div>
      <label className="oc-count-control">数量<select aria-label="批量生成数量" value={data.count ?? 1} disabled={locked} onChange={event => onChange({ count: Number(event.target.value) })}>{Array.from({length:10}, (_,i) => <option key={i+1} value={i+1}>{i+1} 张</option>)}</select></label>
      <button className="oc-generate" aria-label={busy ? "正在生成" : "生成"} title="生成 · Ctrl / ⌘ + Enter" disabled={locked || !canGenerate} onClick={onGenerate}>{busy ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowUp size={18} />}</button>
    </div>
    <div className="oc-result-actions" aria-hidden={!data.image?.url} style={{visibility:data.image?.url?'visible':'hidden'}}>{[["process","送去处理"],["save","另存为"],["project","加入项目"]].map(([action,label]) => <button key={action} className="oc-button" disabled={!data.image?.url} onClick={() => window.dispatchEvent(new CustomEvent("modmind-canvas-image-action", {detail:{action, url:data.image!.url, model:data.model, title:data.title}}))}>{label}</button>)}</div>
    {expanded && <Dialog open onOpenChange={setExpanded}><DialogContent className="open-canvas-modal oc-expanded-prompt"><DialogTitle>编辑提示词</DialogTitle><DialogDescription>修改会同步到当前节点，关闭后保留内容。</DialogDescription><textarea autoFocus aria-label="放大提示词编辑器" style={{ fontSize }} value={data.prompt} onChange={event => onChange({ prompt: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !locked && canGenerate) { event.preventDefault(); setExpanded(false); onGenerate(); } }} /><div className="oc-actions"><button className="oc-button" onClick={() => setExpanded(false)}>完成</button></div></DialogContent></Dialog>}
  </div>;
}
