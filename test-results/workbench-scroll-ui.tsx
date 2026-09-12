import React, { useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import AgentWorkbench from '../src/renderer/src/components/AgentWorkbench'
import type { WorkbenchTimelineItem } from '../src/renderer/src/workbenchTimeline'
import '../src/renderer/src/styles.css'

const noop = () => undefined
type FixtureOptions = Partial<ComponentProps<typeof AgentWorkbench>> & { width?: number; dark?: boolean; rows?: WorkbenchTimelineItem[] }
const timeline = Array.from({ length: 24 }, (_, index) => ({ id: `row-${index}`, kind: 'answer', content: `### Check ${index + 1}\n\nProject analysis result.\n\n${'Verified project configuration and resource references. '.repeat(5)}`, time: new Date().toISOString() })) as WorkbenchTimelineItem[]
function Fixture() {
  const [options, setOptions] = useState<FixtureOptions>({})
  const [prompt, setPrompt] = useState('')
  const [rows, setRows] = useState(timeline)
  const [conversation, setConversation] = useState('test')
  const [longConversations, setLongConversations] = useState(false)
  const [recovery, setRecovery] = useState<import('../src/shared/types').AiRecoveryInfo | null>(null)
  const conversations = longConversations ? ['请帮我逐项检查项目中的所有内容'.repeat(300), 'VeryLongUnbrokenConversationTitle'.repeat(300), '多行标题\n'.repeat(300)].map((title, index) => ({ id: index === 0 ? 'workspace' : `conversation-${index}`, title, sessionScope: index === 0 ? 'workspace' : `workspace/conversation-${index}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })) : []
  Object.assign(window, {
    configureWorkbench: (next: FixtureOptions) => { setOptions(next); if (next.rows) setRows(next.rows) },
    appendOutput: () => setRows(current => [...current, { ...timeline[0], id: `new-${current.length}`, content: 'New output\n\n' + 'Result text. '.repeat(50) }]),
    growOutput: () => setRows(current => current.map((row, index) => index === current.length - 1 ? { ...row, content: row.content + '\n\n' + 'Streamed content. '.repeat(120) } : row)),
    switchConversation: () => { setConversation('other'); setRows(timeline.slice(0, 3)) },
    showLongConversations: () => { setLongConversations(true); setConversation('workspace') }
    ,showRecovery: () => setRecovery({ pending: true, snapshot: null, conversationId: 'workspace', backend: 'quota' })
  })
  return <div className={options.dark ? 'app-shell dark-mode' : ''} style={{ height: '100dvh', width: options.width ?? '100%' }}><AgentWorkbench
    project={{ path: '/fixture', name: 'testmod', namespace: 'testmod', loader: 'fabric', minecraftVersion: '1.21.1', createdAt: new Date().toISOString() }}
    uiMode="beginner" modpack={false} prompt={prompt} setPrompt={setPrompt} attachments={[]} setAttachments={noop}
    planning={!longConversations} taskState="idle" aiPlan={null} aiTodo={[]} aiTimeline={rows} aiOutputStatus="running" aiRecovery={recovery}
    conversations={conversations} activeConversationId={conversation} onSelectConversation={setConversation} onNewConversation={noop} onDeleteConversation={noop}
    backend="quota" onBackendChange={noop} onStart={noop} onCancel={noop} onResume={noop} onDismissRecovery={noop}
    onRename={noop} onSnapshot={noop} onExport={noop} onExportServerPack={noop} onExportLogs={noop} onTest={noop}
    onAttachmentError={noop} canExportArtifact={false} building={false} placeholder="Message" humanizeActivity={value => value}
    {...options}
  /></div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
