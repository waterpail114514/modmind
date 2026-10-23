import { ArrowUp, FolderOpen, Plus } from 'lucide-react'
import ChatWelcome, { ChatRecommendations } from './ChatWelcome'
import QuotaPreferenceControls from './QuotaPreferenceControls'
import type { AiModelInfo, BeginnerAiPreferences, BeginnerReasoningLevel } from '../../../shared/types'
import type { CatalogProvider } from './ModelCatalogRows'

export default function MinimalProjectStart({ draft, onDraftChange, onStart, onOpen, onCreate, preferences, models, connectedProviders, scanning, saving, switching, message, onModelChange, onReasoningLevelChange, onReset, onDeveloper }: {
  onDeveloper?: () => void
  draft: string
  onDraftChange: (draft: string) => void
  onStart: () => void
  onOpen: () => void
  onCreate: () => void
  preferences: BeginnerAiPreferences
  models: AiModelInfo[]
  connectedProviders?: CatalogProvider[]
  scanning?: boolean
  saving: boolean
  switching?: boolean
  message?: string
  onModelChange: (model: string, selection?: import('../../../shared/quotaModels').QuotaModelSelection) => void
  onReasoningLevelChange: (level: BeginnerReasoningLevel) => void
  onReset?: () => void
}): React.JSX.Element {
  const select = (value: string): void => { onDraftChange(value); document.querySelector<HTMLTextAreaElement>('.minimal-project-start textarea')?.focus() }
  return <main className="agent-workbench agent-minimal agent-minimal-empty minimal-project-start">
    {onDeveloper ? <button type="button" className="minimal-developer-entry secondary-button compact" onClick={onDeveloper}>ModMind开发者工作台</button> : null}
    <ChatWelcome mode="workbench" minimal onSelect={select} />
    <div className="agent-composer-stack">
      <form className="agent-composer" onSubmit={event => { event.preventDefault(); if (draft.trim() && !saving) onStart() }}>
        <textarea aria-label="创作需求" disabled={saving} value={draft} rows={2} onChange={event => onDraftChange(event.target.value)} placeholder="说说你想做的模组…" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !saving) onStart() } }} />
        <div className="agent-composer-toolbar"><div className="agent-composer-tools"><button className="agent-icon-button" type="button" aria-label="新建作品" title="新建作品" onClick={onCreate}><Plus size={18} /></button><button className="agent-icon-button" type="button" aria-label="打开项目" title="打开项目" onClick={onOpen}><FolderOpen size={16} /></button><QuotaPreferenceControls preferences={preferences} models={models} connectedProviders={connectedProviders} scanning={scanning} disabled={saving} switching={switching} message={message} onModelChange={onModelChange} onReasoningLevelChange={onReasoningLevelChange} onReset={onReset} /></div><button className="agent-send-button" type="submit" title="发送" aria-label="发送" disabled={!draft.trim() || saving}><ArrowUp size={17} /></button></div>
      </form>
      <div className="chat-welcome minimal-recommendations"><ChatRecommendations mode="workbench" onSelect={select} /></div>
    </div>
  </main>
}
