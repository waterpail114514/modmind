import React from 'react'
import { createRoot } from 'react-dom/client'
import FtbQuestEditor from '../src/renderer/src/components/FtbQuestEditor'
import '../src/renderer/src/styles.css'

const bridge = window as unknown as { backend: (method: string, args: unknown[]) => Promise<unknown>; project: unknown }
const methods = ['readFtbQuestBook', 'saveFtbQuestBook', 'inspectFtbQuestIcon', 'refreshFtbQuestResources', 'ftbQuestShapes', 'ftbDependencyTexture', 'ftbQuestItemNames', 'listFtbQuestBackups', 'restoreFtbQuestBackup']
window.modmind = { modpack: Object.fromEntries(methods.map(method => [method, (...args: unknown[]) => bridge.backend(method, args)])) } as typeof window.modmind
createRoot(document.getElementById('root')!).render(<div className="app-shell dark-mode" style={{ display: 'block', height: '100vh' }}><div className="ftb-quest-host"><FtbQuestEditor project={bridge.project as never} /></div></div>)
