import { useEffect, useMemo, useState } from 'react'
import { Download, LocateFixed, RotateCw, X } from 'lucide-react'
import { ftbIconDescriptor, ftbIconKey } from '../../../shared/ftbIcon'
import type { FtbQuestBook, FtbQuestIconInspection } from '../../../shared/types'
import { clearFtbIconClient, requestFtbIcon } from '../lib/ftbIconClient'

export function FtbIconDiagnostics({ book, projectPath, scope, onClose, onLocate, onRefresh }: { book: FtbQuestBook; projectPath: string; scope: string; onClose: () => void; onLocate: (id: string) => void; onRefresh: () => Promise<void> }): React.JSX.Element {
  const entries = useMemo(() => {
    const found: Array<{ location: string; id: string; descriptor: unknown; key: string }> = []
    const collect = (raw: unknown, location: string, id: string): void => {
      if (!raw || typeof raw !== 'object') return
      for (const [key, value] of Object.entries(raw)) {
        if (['item', 'icon', 'fluid'].includes(key)) {
          const descriptor = ftbIconDescriptor(value)
          if (descriptor) found.push({ location: `${location}/${key}`, id, descriptor, key: ftbIconKey(descriptor) })
        } else if (value && typeof value === 'object') collect(value, `${location}/${key}`, id)
      }
    }
    for (const chapter of book.chapters) {
      collect({ icon: chapter.raw.icon ?? chapter.icon }, chapter.title, chapter.id)
      for (const quest of chapter.quests) {
        collect({ icon: ftbIconDescriptor(quest.raw.icon)?.id === quest.icon ? quest.raw.icon : quest.icon }, `${chapter.title}/${quest.title}`, quest.id)
        for (const object of [...quest.tasks, ...quest.rewards]) collect(object.raw, `${chapter.title}/${quest.title}/${object.title || object.type}`, object.id)
      }
    }
    for (const table of book.rewardTables) collect(table.raw, table.title, table.id)
    return found
  }, [book])
  const [results, setResults] = useState<Record<string, FtbQuestIconInspection>>({})
  const [filter, setFilter] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(true)
  useEffect(() => {
    let alive = true
    setResults({})
    const unique = [...new Map(entries.map(row => [row.key, row])).values()]
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (alive && cursor < unique.length) {
        const row = unique[cursor++]
        try {
          const result = await requestFtbIcon(projectPath, scope, row.descriptor)
          if (alive) setResults(current => ({ ...current, [row.key]: result }))
        } catch (error) { if (alive) setResults(current => ({ ...current, [row.key]: { icon: null, reason: String(error), sources: [], generation: 0 } })) }
      }
    }
    for (let i = 0; i < 4; i++) void worker()
    return () => { alive = false }
  }, [entries, projectPath, scope])
  const exportReport = (): void => {
    const rows = entries.map(row => { const { icon, ...result } = results[row.key] ?? {}; return { ...row, ...result, quality: icon?.quality ?? 'unresolved' } })
    const url = URL.createObjectURL(new Blob([JSON.stringify({ projectPath, timestamp: new Date().toISOString(), rows }, (_, v) => typeof v === 'bigint' ? `${v}L` : v, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'ftb-icon-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="ftb-icon-diagnostics">
    <div className="ftb-quest-panel-title"><strong>图标诊断 ({Object.keys(results).length}/{new Set(entries.map(e=>e.key)).size})</strong><button className="icon-button" title="重新扫描资源" onClick={() => void onRefresh()}><RotateCw size={16} /></button><button className="icon-button" title="导出报告" onClick={exportReport}><Download size={16} /></button><button className="icon-button" title="关闭图标诊断" onClick={onClose}><X size={16} /></button></div>
    <input aria-label="搜索图标" value={filter} onChange={e=>setFilter(e.target.value)} /><label><input type="checkbox" checked={onlyIssues} onChange={e=>setOnlyIssues(e.target.checked)} />仅失败和近似预览</label>
    <div style={{ maxHeight: 400, overflow: 'auto' }}><table><thead><tr><th>原始描述 / 位置</th><th>状态 / 来源</th><th>操作</th></tr></thead><tbody>{entries.filter(row => `${row.key} ${row.location}`.toLowerCase().includes(filter.toLowerCase()) && (!onlyIssues || results[row.key]?.icon?.quality !== 'resolved')).map((row,i) => {
      const result = results[row.key]
      return <tr key={`${row.location}:${i}`}><td style={{ maxWidth: 420, overflowWrap: 'anywhere' }}><code>{row.key}</code><div>{row.location}</div></td><td style={{ maxWidth: 460, overflowWrap: 'anywhere' }}>{result?.icon ? result.icon.quality === 'resolved' ? '静态图标' : '近似预览' : result ? '未解析' : '等待'}<div>{result?.reason}</div><small>{result?.sources.join('\n')}</small></td><td><button className="icon-button" title="定位对象" onClick={() => onLocate(row.id)}><LocateFixed size={16} /></button><button className="icon-button" title="重试此图标" onClick={async () => { await window.modmind.modpack.refreshFtbQuestResources(projectPath, row.descriptor); clearFtbIconClient(); const next = await requestFtbIcon(projectPath, scope, row.descriptor); setResults(current=>({...current,[row.key]:next})) }}><RotateCw size={16} /></button></td></tr>
    })}</tbody></table></div>
  </div>
}
