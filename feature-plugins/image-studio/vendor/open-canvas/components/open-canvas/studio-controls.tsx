"use client";
import { useState, type MouseEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { Check, Clock3, FolderOpen, Grid2X2, Hand, Keyboard, LayoutGrid, Link2, Map, Maximize, Minus, MousePointer2, Palette, Plus, Redo2, Search, Undo2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useCanvasStore } from "./upstream/shared/stores/canvas-store";
import { CanvasPopover } from "./canvas-popover";
import { canvasTheme, type CanvasPreferences, validHexColor } from "./preferences";

export function canvasModifier() { return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"; }
export const canvasShortcuts = [["移动 / 选择节点", "V"], ["抓手工具", "H"], ["临时抓手", "Space + 拖动"], ["撤销", "ModZ"], ["重做", "ModShift+Z"], ["复制 / 粘贴节点", "ModC / ModV"], ["搜索节点", "ModF"], ["全选节点", "ModA"], ["放大 / 缩小", "Mod+ / Mod−"], ["适合屏幕", "Shift+1"], ["适合选中节点", "Shift+2"], ["删除选中", "Delete"], ["生成图片", "ModEnter"]];

export function StudioControls({ onAdd, onUpload, preferences: p, onPreferences: update, zoom, onZoom, onSearch, disabled }: {
  onAdd: (event: MouseEvent<HTMLButtonElement>) => void; onUpload: () => void;
  preferences: CanvasPreferences; onPreferences: (value: Partial<CanvasPreferences>) => void;
  zoom: number; onZoom: (value: number) => void; onSearch: () => void; disabled: boolean;
}) {
  const flow = useReactFlow();
  const [popover, setPopover] = useState<{ kind: "appearance" | "shortcuts" | "zoom" | "tool"; anchor: HTMLElement } | null>(null);
  const hasNodes = useCanvasStore(state => state.nodes.length > 0);
  const canUndo = useCanvasStore(state => state.undoStack.length > 0 && !state.historyTransaction);
  const canRedo = useCanvasStore(state => state.redoStack.length > 0 && !state.historyTransaction);
  const assetCount = useCanvasStore(state => state.nodes.filter(node => node.data.nodeType === "image" && node.data.image?.url || node.data.nodeType === "video" && node.data.video?.url).length);
  const library = (kind: "assets" | "history") => window.dispatchEvent(new CustomEvent("modmind-open-canvas-media", { detail: { kind } }));
  const toggle = (kind: NonNullable<typeof popover>["kind"], event: MouseEvent<HTMLButtonElement>) => { const anchor = event.currentTarget; setPopover(current => current?.kind === kind ? null : { kind, anchor }); };
  const custom = (patch: Partial<CanvasPreferences["custom"]>) => update({ custom: { ...p.custom, ...patch } });
  const theme = canvasTheme(p);
  return <>
    <div className="oc-bottom-tools nodrag nopan">
      <button aria-label="资产管理" onClick={() => library("assets")}><FolderOpen size={16} /><span>{assetCount} 资产管理</span></button>
      <button aria-label={p.links ? "隐藏节点连线" : "显示节点连线"} title="显示 / 隐藏连线" aria-pressed={p.links} onClick={() => update({ links: !p.links })}><Link2 size={15} /></button>
      <button aria-label="切换小地图" title="小地图" aria-pressed={p.miniMap} onClick={() => update({ miniMap: !p.miniMap })}><Map size={15} /></button>
      <button aria-label="网格吸附" title="网格吸附 · 16px" aria-pressed={p.snap} onClick={() => update({ snap: !p.snap })}><Grid2X2 size={15} /></button>
      <button aria-label="适合屏幕" title="适合屏幕 · Shift+1" onClick={() => void flow.fitView({ padding: .24, duration: 180, maxZoom: 1 })}><Maximize size={15} /></button>
      <button aria-label="自动整理节点" title="自动整理节点" disabled={disabled || !hasNodes} onClick={() => {
        const nodes = useCanvasStore.getState().nodes;
        const columns = Math.ceil(Math.sqrt(nodes.length));
        const width = Math.max(540, ...nodes.map(node => (node.measured?.width || 520) + 80)), height = Math.max(400, ...nodes.map(node => (node.measured?.height || 300) + 100));
        useCanvasStore.getState().onNodesChange(nodes.map((node, index) => ({ type: "position" as const, id: node.id, position: { x: (index % columns) * width, y: Math.floor(index / columns) * height } })));
        requestAnimationFrame(() => void flow.fitView({ padding: .2, duration: 180, maxZoom: 1 }));
      }}><LayoutGrid size={15} /></button>
      <button aria-label="缩放画布" aria-expanded={popover?.kind === "zoom"} onClick={event => toggle("zoom", event)}>{zoom}%</button>
    </div>
    <div className="oc-dock nodrag nopan" role="toolbar" aria-label="画布工具栏">
      <button className="oc-dock-add" aria-label="添加节点" title="添加节点" disabled={disabled} onClick={onAdd}><Plus size={21} /></button>
      <button aria-label={p.tool === "hand" ? "抓手工具" : "移动"} aria-haspopup="menu" aria-expanded={popover?.kind === "tool"} title={p.tool === "hand" ? "抓手工具 · H" : "移动 · V"} onClick={event => toggle("tool", event)}>{p.tool === "hand" ? <Hand size={17} /> : <MousePointer2 size={17} />}</button>
      <i /><button aria-label="上传素材" title="上传素材" disabled={disabled} onClick={onUpload}><Upload size={17} /></button>
      <button aria-label="打开素材库" title="素材库" onClick={() => library("assets")}><FolderOpen size={17} /></button><i />
      <button aria-label="画布外观" title="画布外观" aria-expanded={popover?.kind === "appearance"} onClick={event => toggle("appearance", event)}><Palette size={17} /></button>
      <button aria-label="生成历史" title="生成历史" onClick={() => library("history")}><Clock3 size={17} /></button>
      <button aria-label="搜索节点" title={`搜索节点 · ${canvasModifier()}F`} onClick={onSearch}><Search size={16} /></button><i />
      <button aria-label="撤销" title={`撤销 · ${canvasModifier()}Z`} disabled={disabled || !canUndo} onClick={() => useCanvasStore.getState().undo()}><Undo2 size={16} /></button>
      <button aria-label="重做" title={`重做 · ${canvasModifier()}Shift+Z`} disabled={disabled || !canRedo} onClick={() => useCanvasStore.getState().redo()}><Redo2 size={16} /></button>
      <button aria-label="画布快捷键" title="快捷键" aria-expanded={popover?.kind === "shortcuts"} onClick={event => toggle("shortcuts", event)}><Keyboard size={17} /></button>
    </div>
    {popover && <CanvasPopover anchor={popover.anchor} above label={{ tool: "选择工具", appearance: "画布外观", shortcuts: "画布快捷键", zoom: "缩放画布" }[popover.kind]} className={`oc-tools-popover oc-${popover.kind}-popover`} role={popover.kind === "tool" ? "menu" : "dialog"} onClose={() => setPopover(null)}>
      <div className="oc-settings-heading">{{ tool: "选择工具", appearance: "画布外观", shortcuts: "画布快捷键", zoom: "缩放画布" }[popover.kind]}<button aria-label="关闭工具提示" onClick={() => setPopover(null)}><X size={14} /></button></div>
      {popover.kind === "tool" && <div role="group" aria-label="画布工具" className="oc-menu-rows">{([['select', '移动', 'V', MousePointer2], ['hand', '抓手工具', 'H', Hand]] as const).map(([tool, label, key, Icon]) => <button key={tool} role="menuitemradio" aria-checked={p.tool === tool} onClick={() => { update({ tool }); setPopover(null); }}><Icon size={16} /><span>{label}</span>{p.tool === tool && <Check size={13} />}<kbd>{key}</kbd></button>)}</div>}
      {popover.kind === "zoom" && <>
        <div className="oc-zoom-entry"><button aria-label="缩小画布" onClick={() => onZoom(Math.round(zoom / 1.2))}><Minus size={16} /></button><label><input key={zoom} type="number" aria-label="缩放百分比" min="25" max="400" defaultValue={zoom} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 25) onZoom(Math.min(400, value)); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />%</label><button aria-label="放大画布" onClick={() => onZoom(Math.round(zoom * 1.2))}><Plus size={16} /></button></div>
        <input aria-label="画布缩放" type="range" min="25" max="400" value={zoom} onChange={event => onZoom(Number(event.target.value))} />
        <div className="oc-zoom-presets">{[50, 100, 200, 400].map(value => <button key={value} aria-pressed={zoom === value} onClick={() => onZoom(value)}>{value}%</button>)}</div>
        <button className="oc-button" onClick={() => { void flow.fitView({ padding: .24, duration: 180, maxZoom: 1 }); setPopover(null); }}>适合屏幕</button>
      </>}
      {popover.kind === "shortcuts" && <dl className="oc-shortcuts">{canvasShortcuts.map(([label, shortcut]) => <div key={label}><dt>{label}</dt><dd>{shortcut.replaceAll("Mod", canvasModifier())}</dd></div>)}</dl>}
      {popover.kind === "appearance" && <div className="oc-appearance-form">
        <span className="oc-settings-label">空间网格</span><div className="oc-segmented">{([['dots', '点'], ['lines', '线'], ['blank', '空白']] as const).map(([value, label]) => <button key={value} aria-pressed={p.grid === value} onClick={() => update({ grid: value })}>{label}</button>)}</div>
        <label className="oc-check-row"><input type="checkbox" checked={p.snap} onChange={event => update({ snap: event.target.checked })} />网格吸附 <span>16px</span></label>
        <label className="oc-check-row"><input type="checkbox" checked={p.links} onChange={event => update({ links: event.target.checked })} />显示连线</label>
      </div>}
    </CanvasPopover>}
  </>;
}
