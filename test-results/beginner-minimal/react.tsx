import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AgentWorkbench from '../../src/renderer/src/components/AgentWorkbench'
import type { AgentWorkbenchTimelineItem } from '../../src/renderer/src/components/AgentWorkbench'
import type { BeginnerAiPreferences, UiMode } from '../../src/shared/types'
import '../../src/renderer/src/styles.css'

const noop = () => undefined
const bridge = window as any
bridge.calls = { start: 0, cancel: 0, resume: 0, preferences: [], choices: [] }
const project = { path: '/fixture', name: '闪电剑', namespace: 'lightning', loader: 'forge' as const, minecraftVersion: '1.20.1', createdAt: new Date().toISOString() }

function Fixture() {
  const [mode, setMode] = useState<UiMode>('beginner')
  const [prompt, setPrompt] = useState('')
  const [planning, setPlanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [timeline, setTimeline] = useState<AgentWorkbenchTimelineItem[]>(new URLSearchParams(location.search).has('choices') ? [{ id: 'user', kind: 'user', content: '做一把闪电剑', time: new Date().toISOString() }, { id: 'answer', kind: 'answer', content: '可以先做一把蓝色闪电剑。\n<modmind-choices>[{"label":"先聊合成配方","prompt":"先聊这把剑的合成配方","action":"discussion"},{"label":"调整伤害","prompt":"先降低伤害数值","action":"discussion"},{"label":"按这个方案制作","prompt":"确认制作蓝色闪电剑","action":"engineering"}]</modmind-choices>', time: new Date().toISOString() }] : [])
  const [preferences, setPreferences] = useState<BeginnerAiPreferences>({ model: 'gpt-5.6-sol', reasoningLevel: 'medium', fastMode: false })
  const save = (patch: Partial<BeginnerAiPreferences>) => {
    setSaving(true)
    bridge.calls.preferences.push(patch)
    setTimeout(() => { setPreferences(previous => ({ ...previous, ...patch })); setSaving(false) }, 500)
  }
  return <div className="app-shell" style={{ display: 'block', height: '100dvh' }}>
    <AgentWorkbench project={project} uiMode={mode} presentation={mode === 'beginner' ? 'minimal' : 'full'} onUiModeChange={setMode}
      modpack={false} prompt={prompt} setPrompt={setPrompt} attachments={[]} setAttachments={noop}
      planning={planning} taskState={planning ? 'working' : 'idle'} aiPlan={null} aiTodo={[]} aiTimeline={timeline} aiOutputStatus={planning ? 'running' : 'success'} aiRecovery={null}
      onDiscussionChoice={choice => { bridge.calls.choices.push(choice); setPlanning(true) }}
      conversations={[]} activeConversationId="fixture" onSelectConversation={noop} onNewConversation={noop} onDeleteConversation={noop}
      backend="quota" runningBackend="quota" onBackendChange={noop}
      onStart={() => { bridge.calls.start++; setTimeline([{ id: 'request', kind: 'user', content: prompt, time: new Date().toISOString() } as AgentWorkbenchTimelineItem]); setPrompt(''); setPlanning(true) }}
      onCancel={() => { bridge.calls.cancel++; setPlanning(false) }} onResume={() => { bridge.calls.resume++; setPlanning(true) }} onDismissRecovery={noop}
      onRename={noop} onSnapshot={noop} onExport={noop} onExportServerPack={noop} onExportLogs={noop} onTest={noop}
      onAttachmentError={noop} canExportArtifact={false} building={false} placeholder="说说你想做的模组…" humanizeActivity={value => value}
      beginnerAiPreferences={preferences} beginnerAvailableModels={[{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }, { id: 'account-custom-model' }]}
      savingAiPreferences={saving} onModelChange={model => save({ model })} onReasoningLevelChange={reasoningLevel => save({ reasoningLevel })}
    />
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
