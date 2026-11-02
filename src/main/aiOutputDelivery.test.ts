import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { ConversationStore } from './conversationStore'
import { WorkbenchDataStore } from './workbenchDataStore'

it('delivers activity and empty-text reasoning through the real host emitter, durable journal and both projections', async () => {
  const parent = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(parent, 'modmind-output-delivery-'))
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  const store = new ConversationStore(new WorkbenchDataStore(path.join(root, 'userdata')))
  try {
    await store.ensureProjection(project, { id: 'conversation', surface: 'inspiration' })
    const source = await fs.readFile(path.resolve('src/main/index.ts'), 'utf8')
    const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
    const emitter = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendAiOutput')
    if (!emitter) throw new Error('Host emitter missing')
    const compiled = ts.transpileModule(emitter.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const delivered: any[] = [], writes: Promise<unknown>[] = []
    const run = { backend: 'codex', surface: 'inspiration', conversationId: 'conversation', generation: 0, turnId: 'turn' }
    const dependencies = { activeAiRuns: new Map([['run', run]]), recentAiRunRoutes: new Map(),
      describeAiFailureForUser: (text: string) => text, sanitizeAiUserText: (text: string) => text, aiNoticeDetails: () => undefined,
      diagnosticJournal: { record: () => undefined }, app: { getPath: () => '/in-memory-logs' }, path,
      fs: { mkdir: async () => undefined, appendFile: async () => undefined }, redactDiagnosticText: (text: string) => text,
      BrowserWindow: { getAllWindows: () => [] }, conversationStore: { appendOutput: (...args: Parameters<ConversationStore['appendOutput']>) => {
        const promise = store.appendOutput(...args); writes.push(promise); return promise
      } } }
    const make = new Function('deps', `const {${Object.keys(dependencies).join(',')}}=deps; let aiOutputLogWrite=Promise.resolve(); ${compiled}; return sendAiOutput`)
    const send = make(dependencies)
    const event = { sender: { isDestroyed: () => false, send: (_channel: string, payload: unknown) => delivered.push(payload) } }
    const reasoning = { phase: 'completed', summary: ['检查项目'], text: ['确认资源路径'] }
    const activity = { kind: 'tool', title: '读取文件', status: 'completed', startedAt: '2026-10-28T00:00:00Z', output: '文件存在' }
    send(event, 'reasoning', '', 'session', project, 'run', { itemId: 'thought', streamId: 'thought', reasoning })
    send(event, 'tool', activity.title, 'session', project, 'run', { itemId: 'file', streamId: 'file', activity })
    send(event, 'answer', '已验证', 'session', project, 'run')
    await Promise.all(writes)
    expect(delivered[0].reasoning).toEqual(reasoning)
    expect(delivered[1].activity).toEqual(activity)
    const document = await store.read(project, 'conversation')
    expect(document?.events).toHaveLength(3)
    // Keep this host test out of the renderer's separate composite TS project.
    const { replayWorkbenchEvents } = await import('../renderer/src/' + 'workbenchTimeline')
    const { replayInspirationEvents } = await import('../renderer/src/' + 'inspirationOutput')
    const workbench = replayWorkbenchEvents([], document!.events)
    const inspiration = replayInspirationEvents([], document!.events)
    expect(workbench.find((row: any) => row.kind === 'reasoning')?.reasoning?.text).toEqual(['确认资源路径'])
    expect(workbench.find((row: any) => row.activity)?.activity?.output).toBe('文件存在')
    expect(inspiration.find((row: any) => row.kind === 'reasoning')?.reasoning?.text).toEqual(['确认资源路径'])
    expect(inspiration.find((row: any) => row.activity)?.activity?.output).toBe('文件存在')
    expect(inspiration.at(-1)?.content).toBe('已验证')
  } finally {
    await store.flush()
    if (path.dirname(root) !== parent) throw new Error('Unexpected temporary cleanup path')
    await fs.rm(root, { recursive: true, force: true })
  }
})
