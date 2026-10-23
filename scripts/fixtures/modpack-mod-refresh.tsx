import React from 'react'
import { createRoot } from 'react-dom/client'
import ModpackModListWorkspace from '../../feature-plugins/modpack-mods/components/ModpackModListWorkspace'
import { applyAppearance } from '../../src/renderer/src/theme'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/workspace-chrome.css'
import '../../src/renderer/src/palette.css'

async function call(operation: string): Promise<unknown> {
  const response = await fetch('/__mod-refresh/' + operation)
  const value = await response.json()
  if (!response.ok) throw new Error(value.error)
  return value
}
Object.assign(window, { modmind: {
  modpack: { get: () => call('get'), refreshMods: () => call('refresh'), readLock: () => call('lock'), importStatus: () => call('status'), auditLock: () => call('audit') },
  diagnostics: { reportError: () => undefined }
} })
applyAppearance({ themePreset: 'modmind', darkMode: location.search.includes('dark') })
void call('project').then(project => {
  createRoot(document.getElementById('root')!).render(<main className={`app-shell ${location.search.includes('dark') ? 'dark-mode' : ''}`} style={{ height: '100dvh', display: 'block' }}>
    <ModpackModListWorkspace project={project as Parameters<typeof ModpackModListWorkspace>[0]['project']} />
  </main>)
})
