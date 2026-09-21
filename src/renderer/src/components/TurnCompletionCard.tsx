import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, FileCode2 } from 'lucide-react'
import type { WorkbenchTimelineItem } from '../workbenchTimeline'
import './turn-completion-card.css'

export function isTurnCompletion(item: WorkbenchTimelineItem): boolean {
  return item.stage === 'complete' && item.status === 'done'
}

export default function TurnCompletionCard({ item, onOpenFile }: {
  item: WorkbenchTimelineItem
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const files = [...new Set(item.changedFiles ?? [])]
  // Old journals retain only the count. Do not invent file names or line counts.
  const legacyCount = item.content.match(/检测到\s*(\d+)\s*个文件变化/)
  const count = item.changedFiles ? files.length : legacyCount ? Number(legacyCount[1]) : undefined
  const visible = expanded ? files : files.slice(0, 3)
  return <section className="turn-completion-card" aria-label="本轮结果">
    <header className="turn-completion-heading">
      <span className="turn-completion-icon">{count ? <FileCode2 size={20} /> : <Check size={20} />}</span>
      <div><strong>{count ? `已修改 ${count} 个文件` : count === 0 ? '已回复' : '本轮已结束'}</strong>
        <span>{count ? '本轮文件变更' : count === 0 ? '本轮未修改文件' : '回复已结束'}</span></div>
    </header>
    {visible.length ? <ul className="turn-completion-files">{visible.map(path => <li key={path}>
      {onOpenFile ? <button type="button" title={`在代码中打开 ${path}`} onClick={() => onOpenFile(path)}><FileCode2 size={14} /><span>{path}</span></button>
        : <span className="turn-completion-file"><FileCode2 size={14} /><span>{path}</span></span>}
    </li>)}</ul> : null}
    {count && !files.length ? <p className="turn-completion-legacy">这轮历史记录未保存文件列表</p> : null}
    {files.length > 3 ? <button type="button" className="turn-completion-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件列表' : `再显示 ${files.length - 3} 个文件`}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button> : null}
  </section>
}
