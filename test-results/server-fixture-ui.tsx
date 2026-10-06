import React from 'react'
import { createRoot } from 'react-dom/client'
import ModpackToolsWorkspace from '../src/renderer/src/components/ModpackToolsWorkspace'
import { applyAppearance } from '../src/renderer/src/theme'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/palette.css'
const params = new URLSearchParams(location.search)
applyAppearance({ themePreset: 'modmind', darkMode: params.has('dark') })
const test = window as any
test.calls = []
test.task = null
test.failPoll = false
test.reveal = []
const jars = [{ name: 'deepsea-nests-long-fixture-name-0.1.3.jar', path: 'C:/fixtures/deepsea.jar', sha256: 'a'.repeat(64) }, { name: 'dependency-one.jar', path: 'C:/fixtures/one.jar', sha256: 'b'.repeat(64) }, { name: 'dependency-two.jar', path: 'C:/fixtures/two.jar', sha256: 'c'.repeat(64) }]
test.modmind = {
  project: { reveal: async (...args: unknown[]) => { test.reveal.push(args) } },
  localTest: { getState: async () => ({ stage: 'idle', active: false, recentLogs: [], message: '' }), onState: () => () => {} },
  modpack: {
    getServerState: async () => ({ running: false, stage: 'idle', recentLogs: [], message: '', minecraftVersion: '1.20.1' }),
    getServerPackManifest: async () => null, onServerState: () => () => {}, onServerEvent: () => () => {},
    pickScenarioJars: async () => jars,
    removeScenarioJar: async (file: string) => jars.filter(jar => jar.path !== file),
    runServerScenario: async (input: any) => {
      test.calls.push(input)
      if (input.operation === 'files') return { jars: [] }
      if (input.operation === 'state') { if (test.failPoll) throw new Error('查询失败'); return test.task }
      if (input.operation === 'cancel') { test.task = { ...test.task, status: 'cancelled', canCancel: false, message: '隔离测试已取消' }; return test.task }
      test.task = { taskId: '11111111-1111-1111-1111-111111111111', projectPath: 'C:/pack', status: 'running', phase: 'installing', message: '正在安装固定版本的服务端运行时', canCancel: true, completed: 0, total: input.steps.length, recentLogs: [] }
      return test.task
    }
  }
}
createRoot(document.getElementById('root')!).render(<main className="app-shell" style={{ display: 'block', height: '100dvh', overflow: 'auto' }}><div className="main-content" style={{ height: 'auto' }}><ModpackToolsWorkspace section="server" project={{ path: 'C:/pack', name: 'Pack', namespace: 'pack', kind: 'modpack', loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '47.4.23', createdAt: '' }} /></div></main>)
