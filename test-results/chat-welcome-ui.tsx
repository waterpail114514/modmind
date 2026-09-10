import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AgentWorkbench from '../src/renderer/src/components/AgentWorkbench'
import { InspirationWorkspace } from '../src/renderer/src/App'
import '../src/renderer/src/styles.css'

const noop = () => undefined
const project = { path: '/fixture', name: '林间物语', namespace: 'forest', loader: 'fabric' as const, minecraftVersion: '1.21.1', createdAt: new Date().toISOString() }
const bridge = window as any
bridge.sent = []
bridge.modmind = {
  conversations: { list: async () => [], read: async () => null, create: async (_path: string, input: any) => ({ ...input, generation: 0 }), saveView: async () => undefined },
  ai: { onOutput: () => noop, createCode: async (prompt: string) => { bridge.sent.push(prompt); const text = '可以围绕季节、采集和露营设计一个轻松的森林冒险。\n\n' + 'https://example.com/long-resource-path/'.repeat(40) + '\n\n```js\n' + 'const veryLongLine = "' + 'forest'.repeat(100) + '";\n```\n<modmind-followups>["如何设计森林奖励？","怎样安排探索节奏？","露营有哪些互动？"]</modmind-followups>'; return { finalResponse: text, summary: text } } }
}
function Fixture() {
  const [prompt, setPrompt] = useState('')
  const params = new URLSearchParams(location.search)
  const inspiration = params.get('mode') === 'inspiration'
  return <div className={`app-shell ${params.has('dark') ? 'dark-mode' : ''}`} style={{ display: 'block', height: '100dvh' }}>
    {inspiration ? <InspirationWorkspace project={project} visible uiMode="beginner" deviceState={{ status: 'connected', configured: true }} codingBackend="quota" onBusyChange={noop} onConnectionRequired={noop} onSendToCoding={value => { bridge.handoff = value }} /> : <AgentWorkbench
      project={project} uiMode="beginner" modpack={false} prompt={prompt} setPrompt={setPrompt} attachments={[]} setAttachments={noop}
      planning={false} taskState="idle" aiPlan={null} aiTodo={[]} aiTimeline={[]} aiOutputStatus="idle" aiRecovery={null}
      conversations={[]} activeConversationId="fixture" onSelectConversation={noop} onNewConversation={noop} onDeleteConversation={noop}
      backend="quota" onBackendChange={noop} onStart={() => bridge.sent.push(prompt)} onCancel={noop} onResume={noop} onDismissRecovery={noop}
      onRename={noop} onSnapshot={noop} onExport={noop} onExportServerPack={noop} onExportLogs={noop} onTest={noop}
      onAttachmentError={noop} canExportArtifact={false} building={false} placeholder="说说你想做的模组…" humanizeActivity={value => value}
    />}
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
