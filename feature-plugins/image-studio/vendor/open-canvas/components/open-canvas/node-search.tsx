"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./upstream/shared/components/ui/dialog";
import { useCanvasStore } from "./upstream/shared/stores/canvas-store";

export function NodeSearch({ onClose }: { onClose: () => void }) {
  const nodes = useCanvasStore(state => state.nodes), flow = useReactFlow();
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const results = nodes.filter(node => `${node.data.title} ${'prompt' in node.data ? node.data.prompt : ''} ${'model' in node.data ? node.data.model : ''} ${node.data.nodeType}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  function select(id: string) {
    useCanvasStore.getState().onNodesChange(nodes.map(node => ({ type: 'select' as const, id: node.id, selected: node.id === id })));
    void flow.fitView({ nodes: [{ id }], padding: .5, maxZoom: 1, duration: 180 }); onClose();
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="open-canvas-modal oc-search-dialog sm:max-w-xl"><DialogTitle>搜索节点</DialogTitle><DialogDescription>搜索节点名称、提示词或模型，回车定位。</DialogDescription>
    <label className="oc-search-input"><Search size={16} /><input autoFocus aria-label="搜索节点名称、提示词或模型" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setIndex(value => Math.max(0, Math.min(results.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))); }
      if (event.key === 'Enter' && results[index]) select(results[index].id);
    }} /></label>
    <div className="oc-search-results">{results.length ? results.map((node, i) => <button key={node.id} data-active={i === index} onMouseEnter={() => setIndex(i)} onClick={() => select(node.id)}><strong>{node.data.title}</strong><span>{{ image: '图片', video: '视频', text: '文本', note: '便签', audio: '音频' }[node.data.nodeType]}{'model' in node.data && ` · ${node.data.model}`}</span></button>) : <p className="oc-help">没有匹配的节点</p>}</div>
  </DialogContent></Dialog>;
}
