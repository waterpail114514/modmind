import React from 'react'
import { createRoot } from 'react-dom/client'
import { AdoptProjectDialog } from '../src/renderer/src/App'
import { applyAppearance } from '../src/renderer/src/theme'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/palette.css'
const params = new URLSearchParams(location.search)
applyAppearance({ themePreset: 'modmind', darkMode: params.has('dark') })
const test = window as any
test.calls = []
test.modmind = { project: { adoptExisting: async (form: unknown) => {
  test.calls.push(form)
  if (test.fail) throw new Error('fixture adoption failure')
  return { ...form as object, path: 'C:/projects/printer' }
} } }
const versions = params.has('unknown') ? [] : ['1.18.2', '1.20.1', '1.21.1', '26.1.2', '26.2']
createRoot(document.getElementById('root')!).render(<main className="app-shell" style={{ display: 'block', height: '100dvh' }}>
  <AdoptProjectDialog analysis={{ sourcePath: 'C:/projects/litematica-printer', sourceName: 'litematica-printer', kind: 'complete', fileCount: 200, sourceFileCount: 70, documentCount: 3, detectedFiles: ['build.gradle.kts', 'gradle.properties', 'fabric.mod.json'], reasons: [], minecraftVersions: versions, inferred: { name: 'Litematica Printer', namespace: 'litematica_printer', loader: 'fabric', minecraftVersion: '' } }} onClose={() => {}} onAdopted={() => { test.adopted = true }} />
</main>)
