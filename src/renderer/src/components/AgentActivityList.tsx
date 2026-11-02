import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronRight, CircleAlert, Clock3, FilePlus2, Hammer, Images, LoaderCircle, Pencil, ScanLine, Search, ShieldCheck, SquareTerminal, Wrench } from 'lucide-react'
import type { WorkbenchTimelineItem } from '../workbenchTimeline'
import { INSPIRATION_STAGE_PROGRESS } from '../inspirationProgress'
import { AiNoticeDetails } from './AiNoticeDetails'
import './agent-activity.css'

// Old journals have titles but no structured activity. Classify only the action
// prefix, never arbitrary command output, and leave their recorded state intact.
function legacyActivityIcon(item: WorkbenchTimelineItem, title: string) {
  const action = title.trim().replace(/^(?:AI|Agent|Codex|智能开发引擎)\s*/iu, '')
  if (/^(?:正在执行命令|命令已完成|(?:正在|已)?运行命令|执行命令|运行了.*命令|running command|command completed)/iu.test(action)) return SquareTerminal
  if (/^(?:(?:正在|已)?(?:执行)?构建|Gradle\s*构建|正在运行\s*Gradle|running Gradle|build(?:ing)?\b)/iu.test(action)) return Hammer
  if (/^(?:已|正在)?创建(?:了)?(?:文件|代码)/u.test(action)) return FilePlus2
  if (/^(?:已应用代码修改|applied changes|(?:正在|已)?(?:编辑|修改|写入)(?:了|项目|代码|文件))/iu.test(action)) return Pencil
  if (/^(?:正在|已)?(?:搜索|检索)/u.test(action)) return Search
  if (/^(?:正在|已)?(?:检查操作权限|检查权限|权限检查|自动审批)/u.test(action)) return ShieldCheck
  if (/^(?:已查看\s*\d+\s*张(?:图像|图片)|(?:正在|已)?(?:查看|生成)(?:图像|图片))/u.test(action)) return Images
  if (/^(?:上下文已自动压缩|(?:正在|已)?压缩上下文)/u.test(action)) return ScanLine
  return item.kind === 'thinking' ? Brain : item.kind === 'tool' ? Wrench : Clock3
}

function activityIcon(item: WorkbenchTimelineItem, title = item.content.split('\n')[0]) {
  const activity = item.activity
  if (activity?.status === 'failed' || item.status === 'error') return CircleAlert
  if (activity?.status === 'cancelled' || activity?.status === 'interrupted' || item.status === 'warning') return Clock3
  if (!activity) return legacyActivityIcon(item, title)
  if (activity.kind === 'command') return SquareTerminal
  if (activity.kind === 'file') return activity.files?.length && activity.files.every(file => file.operation === 'create') ? FilePlus2 : Pencil
  if (activity.kind === 'build') return Hammer
  if (activity.kind === 'search') return Search
  if (activity.kind === 'approval') return ShieldCheck
  return /(?:图像|图片)/u.test(activity.title) ? Images : Wrench
}

function activityTitle(item: WorkbenchTimelineItem, legacyTitle: string): string {
  const activity = item.activity
  if (!activity) return legacyTitle
  if (activity.tool === INSPIRATION_STAGE_PROGRESS) return activity.title
  const running = item.status === 'running'
  const failed = activity.status === 'failed' || item.status === 'error'
  if (activity.status === 'cancelled' || activity.status === 'interrupted') return `${activity.title} · ${activity.status === 'cancelled' ? '已取消' : '结果未确认'}`
  if (activity.kind === 'command') return running ? '正在运行' : failed ? '命令失败' : '已运行'
  if (activity.kind === 'file') return running ? '正在编辑文件' : failed ? '文件修改失败' : '已编辑文件'
  return `${activity.title}${running ? '' : failed ? '失败' : '完成'}`
}

function ActivityRow({ item, normalize, onOpenFile }: { item: WorkbenchTimelineItem; normalize: (value: string) => string; onOpenFile?: (path: string) => void }) {
  const activity = item.activity
  const [expanded, setExpanded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const running = item.status === 'running'
  const failed = activity?.status === 'failed' || item.status === 'error'
  const stopped = activity?.status === 'cancelled' || activity?.status === 'interrupted'
  const started = activity?.startedAt ?? item.time
  useEffect(() => {
    if (!running) return
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [running, started])
  const content = normalize(item.content)
  const [legacyTitle, ...legacyDetail] = content.split('\n')
  const title = activityTitle(item, legacyTitle)
  const Icon = activityIcon(item, legacyTitle)
  const details = activity?.output || activity?.detail || legacyDetail.join('\n')
  const hasDetails = Boolean(details || activity?.command || item.notice)
  const label = activity?.command || activity?.detail
  return <div className={`agent-activity-item${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}>
    {activity?.kind !== 'file' || !activity.files?.length || failed || stopped ? <button type="button" className="agent-activity-line" aria-expanded={hasDetails ? expanded : undefined} aria-label={`${title}${label ? ` ${label}` : ''}`} onClick={() => hasDetails && setExpanded(value => !value)} disabled={!hasDetails}>
      {running ? <LoaderCircle size={13} className="spin" /> : <Icon size={13} />}
      <span className="agent-activity-label">{title}</span>
      {label ? <span className="agent-activity-context" title={label}>{label}</span> : null}
      {activity?.progress && activity.progress.total > 0 ? <span className="agent-activity-meta">{Math.min(100, Math.round(activity.progress.current / activity.progress.total * 100))}%</span> : null}
      {running ? <span className="agent-activity-meta">{elapsed}s</span> : null}
      {hasDetails ? <ChevronRight size={12} className={`agent-activity-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true" /> : null}
    </button> : null}
    {activity?.files?.map((file, index) => <div className="agent-activity-file" key={`${file.path}:${index}`}>
      {file.operation === 'create' ? <FilePlus2 size={13} /> : <Pencil size={13} />}
      <span>{running ? '正在编辑' : failed ? '修改失败' : stopped ? '修改未确认' : file.operation === 'create' ? '已创建' : file.operation === 'delete' ? '已删除' : '已编辑'}</span>
      <button type="button" className="agent-activity-path" title={file.path} disabled={!onOpenFile || file.operation === 'delete' || /^(?:[\\/]|[a-z]:[\\/]|\.\.(?:[\\/]|$))/i.test(file.path)} onClick={() => onOpenFile?.(file.path)}>{file.path.replaceAll('\\', '/').split('/').at(-1)}</button>
      {file.added !== undefined ? <span className="agent-activity-added">+{file.added}</span> : null}
      {file.removed !== undefined ? <span className="agent-activity-removed">−{file.removed}</span> : null}
      {running ? <span className="agent-activity-pending" aria-label="修改中" /> : null}
      {hasDetails && !failed && !stopped ? <button type="button" className="agent-activity-file-disclosure" aria-label={`查看 ${file.path.replaceAll('\\', '/').split('/').at(-1)} 的修改详情`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronRight size={12} className={expanded ? 'expanded' : ''} /></button> : null}
    </div>)}
    {expanded && hasDetails ? <div className="agent-activity-detail">{activity?.command ? <code>{activity.command}</code> : null}{details ? <pre>{details}</pre> : null}<AiNoticeDetails notice={item.notice} /></div> : null}
  </div>
}

function summary(items: WorkbenchTimelineItem[]): { title: string; Icon: typeof Pencil } {
  const current = [...items].reverse().find(item => item.status === 'running')
    ?? [...items].reverse().find(item => item.status === 'error' || item.activity?.status === 'failed')
    ?? [...items].reverse().find(item => item.status === 'warning' || item.activity?.status === 'cancelled' || item.activity?.status === 'interrupted')
  if (current) return { title: activityTitle(current, current.content.split('\n')[0]), Icon: current.status === 'running' ? LoaderCircle : activityIcon(current) }
  const commands = items.filter(item => activityIcon(item) === SquareTerminal).length
  const files = new Set(items.flatMap(item => item.activity?.status === 'completed' ? item.activity.files?.map(file => file.path) ?? [] : [])).size
  const fileItems = items.filter(item => [Pencil, FilePlus2].includes(activityIcon(item)))
  if (files || fileItems.length) return { title: [files ? `编辑了 ${files} 个文件` : '编辑了文件', commands ? `运行了 ${commands} 条命令` : ''].filter(Boolean).join('并'), Icon: commands || fileItems.some(item => activityIcon(item) === Pencil) ? Pencil : FilePlus2 }
  if (commands) return { title: commands === 1 ? '运行了命令' : `运行了 ${commands} 条命令`, Icon: SquareTerminal }
  const last = items.at(-1)!
  return { title: items.length === 1 ? activityTitle(last, last.content.split('\n')[0]) : `执行了 ${items.length} 个步骤`, Icon: activityIcon(last) }
}

/** Quiet, bounded process history. Live rows update in place without expanding output. */
export default function AgentActivityList({ items, humanizeActivity = value => value, onOpenFile }: { items: WorkbenchTimelineItem[]; humanizeActivity?: (value: string) => string; onOpenFile?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const running = items.some(item => item.status === 'running')
  useEffect(() => {
    const element = scroll.current
    if (element && follow.current && running) element.scrollTop = element.scrollHeight
  }, [items, expanded, running])
  if (!items.length) return null
  const { title, Icon } = summary(items)
  const current = [...items].reverse().find(item => item.status === 'running')
  const currentDetail = current?.activity?.detail || current?.activity?.command || current?.content.split('\n')[1] || '正在执行'
  return <section className="agent-activity-list" aria-label="执行过程">
    <button type="button" className="agent-activity-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <Icon className={running ? 'spin' : undefined} size={13} />
      <span>{humanizeActivity(title)}</span>{expanded ? <ChevronDown className="agent-activity-chevron" size={12} aria-hidden="true" /> : <ChevronRight className="agent-activity-chevron" size={12} aria-hidden="true" />}
    </button>
    {expanded ? <div className="agent-activity-scroll" ref={scroll} onScroll={() => { const e = scroll.current; if (e) follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 28 }}>
      {items.map(item => <ActivityRow key={item.id} item={item} normalize={humanizeActivity} onOpenFile={onOpenFile} />)}
    </div> : running ? <div className="agent-activity-collapsed" role="status">{currentDetail}</div> : null}
  </section>
}
