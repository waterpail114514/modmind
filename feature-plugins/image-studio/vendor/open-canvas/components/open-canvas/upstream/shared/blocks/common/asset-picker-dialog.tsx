'use client';
/* eslint-disable @next/next/no-img-element -- The local asset library displays browser-owned images. */

import { useEffect, useState } from 'react';
import { Image as ImageIcon, Video } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog';
import { getOpenCanvasRuntime } from '../../../../../../lib/open-canvas/runtime';

export type AssetItem = {
  id: string;
  url: string;
  source: 'upload' | 'generate';
  thumbnailUrl?: string | null;
  durationSec?: number | null;
  size?: number | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  onSelect?: (items: AssetItem[]) => void;
  accept?: 'image' | 'video';
  confirmLabel?: string;
  mediaType?: 'image' | 'video';
  selectedUrls?: string[];
  labels?: { title?: string; description?: string; empty?: string; signInRequired?: string; confirm?: string; cancel?: string; useSelected?: string; selectedCount?: string };
};

export function AssetPickerDialog({ open, onOpenChange, title, onSelect, accept, mediaType }: Props) {
  const [assets, setAssets] = useState<(AssetItem & { type: 'image' | 'video'; title: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    const runtime = getOpenCanvasRuntime();
    void Promise.resolve().then(async () => {
      setLoading(true); setError('');
      await runtime.flushStudio();
      const items = await runtime.listAssets();
      if (!canceled) setAssets(items.filter(item => !(accept || mediaType) || item.type === (accept || mediaType)).map(item => ({ ...item, source: item.source === 'uploaded' ? 'upload' : 'generate' })));
    }).catch(failure => { if (!canceled) setError(failure instanceof Error ? failure.message : '素材读取失败'); }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [open, accept, mediaType]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="open-canvas-modal max-h-[85dvh] overflow-y-auto border-white/10 bg-[#141619] text-white sm:max-w-2xl">
      <DialogTitle>{title || '本机素材库'}</DialogTitle>
      <DialogDescription className="text-zinc-400">选择本账号在当前浏览器中上传或生成的素材。</DialogDescription>
      {loading ? <p className="oc-help" role="status">正在读取素材…</p> : error ? <p className="oc-error" role="alert">{error}</p> : assets.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {assets.map(asset => <button key={asset.id} className="overflow-hidden rounded-xl border border-white/15 bg-white/5 text-left hover:border-emerald-200/60" onClick={() => { onSelect?.([asset]); onOpenChange(false); }}>
          {asset.type === 'image' ? <img src={asset.url} alt={asset.title} className="h-32 w-full object-cover" /> : <div className="flex h-32 items-center justify-center"><Video size={30} /></div>}
          <span className="flex items-center gap-2 truncate p-3 text-xs"><ImageIcon size={14} />{asset.title}</span>
        </button>)}
      </div> : <p className="oc-help">暂无素材。上传图片或完成生成后，即可在这里重复使用。</p>}
    </DialogContent>
  </Dialog>;
}
