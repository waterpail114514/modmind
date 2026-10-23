import { useMemo, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { createChatStarters, type ChatStarterMode } from '../chatStarters'
import { useFeaturePlugins } from '../featurePlugins'
import { studioRecords } from '../../../shared/studios'
import type { ProjectInfo } from '../../../shared/types'

export function ChatRecommendations({ mode, project, onSelect, disabled = false }: {
  mode: ChatStarterMode
  project?: ProjectInfo
  onSelect: (prompt: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const { catalog } = useFeaturePlugins()
  const [generation, setGeneration] = useState(0)
  const suggestions = useMemo(() => createChatStarters(mode, project, studioRecords(catalog)).suggestions, [mode, project, catalog, generation])
  return <div className="chat-welcome-recommendations">
    <div className="chat-welcome-label"><span>{mode === 'workbench' ? '为您推荐' : '不妨从这里聊起'}</span><button type="button" disabled={disabled} onClick={() => setGeneration(value => value + 1)} aria-label="换一组推荐"><RefreshCw size={12} />换一组</button></div>
    <div className="chat-welcome-options">{suggestions.map((suggestion, index) => <button type="button" key={suggestion.title} disabled={disabled} onClick={() => onSelect(suggestion.prompt)} title={suggestion.prompt}>
      {mode === 'inspiration' ? <small>{String(index + 1).padStart(2, '0')}</small> : null}<span>{suggestion.title}</span><ArrowUpRight size={14} />
    </button>)}</div>
  </div>
}

export default function ChatWelcome({ mode, project, onSelect, disabled = false, minimal = false }: {
  mode: ChatStarterMode
  project?: ProjectInfo
  onSelect: (prompt: string) => void
  disabled?: boolean
  minimal?: boolean
}): React.JSX.Element {
  const { catalog } = useFeaturePlugins()
  const content = useMemo(() => createChatStarters(mode, project, studioRecords(catalog)), [mode, project, catalog])
  return <section className={`chat-welcome ${mode}`} aria-label={mode === 'workbench' ? '开始创作' : '探索灵感'}>
    <div className="chat-welcome-greeting"><h2>{content.greeting}</h2></div>
    {!minimal ? <ChatRecommendations mode={mode} project={project} disabled={disabled} onSelect={onSelect} /> : null}
  </section>
}
