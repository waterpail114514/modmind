"use client";
import { useMemo } from "react";
import { Copy, Expand, Image as ImageIcon, Plus, Redo2, RotateCcw, Trash2, Undo2, Upload, type LucideIcon } from "lucide-react";
import { CanvasPopover } from "./canvas-popover";
import { canvasModifier } from "./studio-controls";
import type { CanvasNodeType } from "./upstream/shared/lib/canvas/types";

export function CanvasCommandMenu({ menu, items, canUndo, canRedo, disabled, onClose, onAdd, onSelect, onUpload, onAssets, onHistory, onCopyNode, onDeleteNode, onDeleteEdge, onPreview, onUndo, onRedo, onPaste }: {
  menu: { x: number; y: number; mode: 'quick-add' | 'pane' | 'connection' | 'node' | 'edge'; above?: boolean; nodeId?: string; edgeId?: string };
  items: { nodeType: CanvasNodeType; label: string; disabled?: boolean; disabledReason?: string; icon: LucideIcon }[];
  canUndo: boolean; canRedo: boolean; disabled: boolean; onClose: () => void;
  onAdd: () => void; onSelect: (type: CanvasNodeType) => void; onUpload: () => void; onAssets: () => void; onHistory: () => void;
  onCopyNode: (id: string) => void; onDeleteNode: (id: string) => void; onDeleteEdge: (id: string) => void;
  onPreview?: () => void; onUndo: () => void; onRedo: () => void; onPaste: () => void;
}) {
  const anchor = useMemo(() => ({ x: menu.x, y: menu.y }), [menu.x, menu.y]);
  const title = { pane: '画布命令', node: '节点操作', edge: '连线操作', connection: '基于此素材生成', 'quick-add': '添加节点' }[menu.mode];
  return <CanvasPopover anchor={anchor} above={menu.above} label={title} className="canvas-quick-add-menu" onClose={onClose}>
    <div className="oc-add-menu-heading">{title}</div>
    <div className="oc-menu-rows oc-add-menu-items">
      {menu.mode === 'pane' ? <>
        <button role="menuitem" disabled={disabled} onClick={onAdd}><Plus size={16} /><span>添加节点</span></button>
        <button role="menuitem" disabled={disabled} onClick={onUpload}><Upload size={16} /><span>上传到这里</span></button>
        <button role="menuitem" disabled={disabled} onClick={onAssets}><ImageIcon size={16} /><span>从素材库插入</span></button>
        <span className="oc-menu-section">历史与剪贴板</span>
        <button role="menuitem" disabled={disabled || !canUndo} onClick={onUndo}><Undo2 size={16} /><span>撤销</span><kbd>{canvasModifier()}Z</kbd></button>
        <button role="menuitem" disabled={disabled || !canRedo} onClick={onRedo}><Redo2 size={16} /><span>重做</span><kbd>{canvasModifier()}Shift+Z</kbd></button>
        <button role="menuitem" disabled={disabled} onClick={onPaste}><Copy size={16} /><span>粘贴</span><kbd>{canvasModifier()}V</kbd></button>
      </> : menu.mode === 'node' ? <>
        {onPreview && <button role="menuitem" onClick={onPreview}><Expand size={16} /><span>全景预览</span></button>}
        <button role="menuitem" disabled={disabled} onClick={() => menu.nodeId && onCopyNode(menu.nodeId)}><Copy size={16} /><span>复制节点</span></button>
        <button role="menuitem" disabled={disabled} onClick={() => menu.nodeId && onDeleteNode(menu.nodeId)}><Trash2 size={16} /><span>删除节点</span></button>
      </> : menu.mode === 'edge' ? <button role="menuitem" disabled={disabled} onClick={() => menu.edgeId && onDeleteEdge(menu.edgeId)}><Trash2 size={16} /><span>删除连线</span></button> : <>
        <span className="oc-menu-section">创作节点</span>
        {items.filter(item => item.nodeType === "image" || item.nodeType === "note" || item.nodeType === "text").map(item => <button role="menuitem" aria-label={item.label} key={item.nodeType} disabled={disabled || item.disabled} title={item.disabledReason} onClick={() => onSelect(item.nodeType)}><item.icon size={16} /><span>{{ text: '文本', note: '便签', image: '图片', video: '视频', audio: '音频' }[item.nodeType]}</span>{item.disabled && <small>{item.disabledReason}</small>}</button>)}
        {menu.mode === 'quick-add' && <><span className="oc-menu-section">导入资源</span><button role="menuitem" disabled={disabled} onClick={onUpload}><Upload size={16} /><span>上传</span></button><button role="menuitem" disabled={disabled} onClick={onHistory}><RotateCcw size={16} /><span>从生成历史选择</span></button><button role="menuitem" disabled={disabled} onClick={onAssets}><ImageIcon size={16} /><span>素材库</span></button></>}
      </>}
    </div>
  </CanvasPopover>;
}
