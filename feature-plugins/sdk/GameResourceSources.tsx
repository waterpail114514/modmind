import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react'
import './game-resource-sources.css'

type Source = { key: string; title: string; count: number | null; instanceDir: string; capturedAt: string }
export default function GameResourceSources({ projectPath, onChanged, onClose, featureId = 'mc-pull', actionPrefix = 'pull:' }: { projectPath: string; onChanged: () => void; onClose: () => void; featureId?: string; actionPrefix?: string }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(true)
  const [sources, setSources] = useState<Source[]>([]), [active, setActive] = useState(''), [busy, setBusy] = useState('读取资源来源'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [remove, setRemove] = useState('')
  const invoke = (action: string, input: Record<string, unknown> = {}) => window.modmind.featurePlugins.invoke(featureId, action.replace(/^pull:/, actionPrefix), { ...input, projectPath })
  const load = async () => { const result = await invoke('pull:sources') as { packs: Source[]; activeKey: string }; if (alive.current) { setSources(result.packs); setActive(result.activeKey) } }
  const run = async (label: string, operation: () => Promise<unknown>, changed = false) => {
    setBusy(label); setError(''); setNotice('')
    try { await operation(); await load(); if (changed && alive.current) onChanged() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy('') }
  }
  useEffect(() => { alive.current = true; dialog.current?.showModal(); void run('读取资源来源', load); return () => { alive.current = false } }, [projectPath, featureId, actionPrefix])
  return <dialog ref={dialog} className="dialog game-resource-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose() }} aria-labelledby="game-resource-title">
    <div className="game-resource-heading"><h2 id="game-resource-title">资源来源</h2><button type="button" className="icon-button" aria-label="关闭资源来源" disabled={Boolean(busy)} onClick={onClose}><X size={18} /></button></div>
    <div className="game-resource-toolbar"><button className="primary-button" disabled={Boolean(busy)} onClick={() => void run('读取本地实例', async () => { const choice = await invoke('pull:chooseInstance') as { instanceDir: string | null }; if (choice.instanceDir) await invoke('pull:run', { instanceDir: choice.instanceDir }) }, true)}><FolderOpen size={16} />选择游戏实例</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('导入探针结果', async () => { const choice = await invoke('pull:chooseProbe') as { probeDir: string | null }; if (choice.probeDir) await invoke('pull:importProbe', { probeDir: choice.probeDir }) }, true)}>导入已有探针结果</button></div>
    <div className="game-resource-list" aria-busy={Boolean(busy)}>{sources.length ? sources.map(source => <div className="game-resource-row" key={source.key}>
      <label><input type="radio" name="game-resource-source" checked={active === source.key} disabled={Boolean(busy)} onChange={() => void run('切换资源来源', () => invoke('pull:select', { key: source.key }), true)} /><span><strong>{source.title}</strong><span>{source.count === null ? '需要重新读取' : `${source.count} 项资源`}{active === source.key ? ' · 当前使用' : ''}</span></span></label>
      <div className="game-resource-actions"><button className="icon-button" aria-label={`刷新 ${source.title}`} disabled={Boolean(busy) || !source.instanceDir} onClick={() => void run('刷新实例资源', () => invoke('pull:run', { instanceDir: source.instanceDir }), true)}><RefreshCw size={15} /></button><button className="icon-button" aria-label={`导出 ${source.title}`} disabled={Boolean(busy)} onClick={() => void run('导出采集包', async () => { const result = await invoke('pull:exportPack', { key: source.key }) as { file: string }; if (alive.current) setNotice(`已导出至 ${result.file}`) })}><Download size={15} /></button><button className="icon-button" aria-label={`清理 ${source.title}`} disabled={Boolean(busy)} onClick={() => setRemove(source.key)}><Trash2 size={15} /></button></div>
      {remove === source.key ? <div className="game-resource-confirm"><span>清理此来源的采集结果？需要时可从实例重新读取。</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => setRemove('')}>取消</button><button className="danger-button" disabled={Boolean(busy)} onClick={() => void run('清理采集结果', async () => { await invoke('pull:clear', { key: source.key }); setRemove('') }, true)}>清理采集结果</button></div> : null}
    </div>) : !busy ? <p className="game-resource-empty">使用原版目录，或选择本地实例补充模组资源。</p> : null}</div>
    <div className="game-resource-status" role="status">{busy ? <><LoaderCircle size={15} className="spin" />{busy}…</> : notice}</div>
    {error ? <div role="alert" className="game-resource-error">{error}<button className="secondary-button" onClick={() => void run('读取资源来源', load)}>重试</button></div> : null}
  </dialog>
}
