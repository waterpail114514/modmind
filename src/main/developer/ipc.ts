import { app, BrowserWindow, dialog, ipcMain, protocol, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeveloperService } from './service'
import { developerBridge } from './tools'
import type { ExternalAgentRunOptions, ExternalAgentRunResult } from '../externalAgents'
import type { AiModelSelection } from '../../shared/aiSelection'
import type { AgentSettings, ProjectInfo } from '../../shared/types'
import type { DeveloperConversation, DeveloperDebugInput } from '../../shared/developerWorkbench'

export interface DeveloperAiHost {
  appearance?: () => Promise<import('../../shared/appTheme').AppAppearance>
  run: (options: ExternalAgentRunOptions, backend: AgentSettings['codingBackend'], sender: WebContents, selection?: AiModelSelection) => Promise<ExternalAgentRunResult>
}
export function registerDeveloperIpc(host: DeveloperAiHost): void {
  const sessions = new Map<number, { service: DeveloperService; ai: AbortController | null }>()
  const previews = new Map<string, { owner: number; session: string; buildId: string; html: string; expires: number }>()
  const captures = new Map<number, { service: DeveloperService; session: string }>()
  ipcMain.handle('developer:captureInvoke', (event, channel, args) => {
    const capture = captures.get(event.sender.id)
    if (!capture) throw new Error('截图预览已失效')
    return capture.service.previewInvoke(capture.session, channel, args).then(value => value.result)
  })
  protocol.handle('modmind-dev-preview', async request => {
    const [token, kind, id, ...parts] = new URL(request.url).pathname.slice(1).split('/').map(decodeURIComponent), value = previews.get(token)
    if (!value || value.expires < Date.now() || sessions.get(value.owner)?.service.project?.session !== value.session) { previews.delete(token); return new Response('预览已失效，请重新运行预览。', { status: 404 }) }
    if (!kind) return new Response(value.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    if (kind !== 'features' && kind !== 'minipaint') return new Response('资源不存在', { status: 404 })
    try {
      let bytes: Buffer
      if (kind === 'minipaint') {
        const relative = [id, ...parts].join('/')
        if (relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('公共资源路径无效')
        const root = await fs.realpath(path.join(app.getAppPath(), 'out/renderer/minipaint'))
        const file = await fs.realpath(path.join(root, relative)), scoped = path.relative(root, file)
        if (scoped.startsWith('..') || path.isAbsolute(scoped)) throw new Error('公共资源路径越界')
        bytes = await fs.readFile(file)
      } else bytes = await sessions.get(value.owner)!.service.previewResource(value.session, value.buildId, id, parts.join('/'))
      const types: Record<string,string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
      const extension = path.extname(parts.at(-1) ?? id)
      if (['.html','.js','.css','.json'].includes(extension)) bytes = Buffer.from(bytes.toString('utf8').replaceAll('modmind-feature://', `${new URL(request.url).origin}/${token}/features/`))
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': types[extension] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
    } catch { return new Response('预览资源不可用，请重新运行预览', { status: 404 }) }
  })
  const kit = app.isPackaged ? path.join(process.resourcesPath, 'developer-kit') : path.join(app.getAppPath(), 'resources/developer-kit')
  const state = (sender: WebContents) => {
    let entry = sessions.get(sender.id)
    if (!entry) {
      entry = { service: new DeveloperService(kit, app.getPath('userData'), { path: app.getAppPath(), packaged: app.isPackaged, dependencyRoots: [path.join(app.getPath('userData'), 'feature-plugins'), path.join(app.getAppPath(), 'feature-plugin-dist'), app.isPackaged ? path.join(process.resourcesPath,'bundled-studios') : path.join(app.getAppPath(),'resources/bundled-studios')] }), ai: null }; sessions.set(sender.id, entry)
      const service = entry.service
      service.onPreviewEvent((channel, args) => { if (service.project && !sender.isDestroyed()) sender.send('developer:previewEvent', { session: service.project.session, channel, args }) })
      sender.on('will-frame-navigate', event => { if (!event.isMainFrame && event.frame?.url.startsWith('modmind-dev-preview:') && !event.url.startsWith('modmind-dev-preview:')) event.preventDefault() })
      sender.once('destroyed', () => { const entry = sessions.get(sender.id); entry?.ai?.abort(); void entry?.service.close(); sessions.delete(sender.id) })
    }
    return entry
  }
  const handle = (name: string, callback: (sender: WebContents, ...args: any[]) => unknown) => ipcMain.handle('developer:' + name, (event, ...args) => callback(event.sender, ...args))
  const idle = (sender: WebContents): DeveloperService => { const entry = state(sender); if (entry.ai) throw new Error('请先停止开发 AI 任务'); return entry.service }
  handle('recent', sender => state(sender).service.recent())
  let editorTypes: Promise<{ path: string; content: string }[]> | undefined
  handle('editorTypes', () => editorTypes ??= (async () => {
    const result: { path: string; content: string }[] = []
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), prefix + entry.name + '/')
        else if (entry.name.endsWith('.d.ts')) result.push({ path: prefix + entry.name, content: await fs.readFile(path.join(directory, entry.name), 'utf8') })
      }
    }
    await visit(path.join(kit, 'types'), 'file:///node_modules/@types/')
    for (const name of ['csstype', 'undici-types']) await visit(path.join(kit, 'node_modules', name), 'file:///node_modules/' + name + '/')
    result.push({ path: 'file:///node_modules/@modmind/sdk/index.d.ts', content: await fs.readFile(path.join(kit, 'sdk.d.ts'), 'utf8') })
    result.push({ path: 'file:///node_modules/lucide-react/index.d.ts', content: await fs.readFile(path.join(kit, 'lucide.d.ts'), 'utf8') })
    result.push({ path: 'file:///node_modules/react/jsx-runtime.d.ts', content: 'export * from "../@types/react/jsx-runtime"' })
    result.push({ path: 'file:///modmind-developer/styles.d.ts', content: 'declare module "*.css"; declare module "*.png"; declare module "*.jpg"; declare module "*.svg"; declare module "*.webp";' })
    return result
  })().catch(error => { editorTypes = undefined; throw error }))
  handle('create', async (sender, input) => {
    const service = idle(sender), owner = BrowserWindow.fromWebContents(sender)
    const options = { title: '选择开发工程的保存位置', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : service.create(result.filePaths[0], input)
  })
  handle('open', async (sender, root?: string) => {
    const service = idle(sender)
    if (root) return service.open(root)
    const owner = BrowserWindow.fromWebContents(sender), options = { title: '打开 ModMind 开发工程', properties: ['openDirectory'] as 'openDirectory'[] }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return selected.canceled || !selected.filePaths[0] ? null : service.open(selected.filePaths[0])
  })
  handle('importPackage', async sender => {
    const service = idle(sender), owner = BrowserWindow.fromWebContents(sender)
    const options = { title: '导入现有功能或工作台', properties: ['openFile'] as 'openFile'[], filters: [{ name: 'ModMind 功能与工作台包', extensions: ['mmfeature', 'mmstudio'] }] }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0]) return null
    const destination = { title: '选择导入工程的保存位置（将创建独立副本）', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const parent = owner ? await dialog.showOpenDialog(owner, destination) : await dialog.showOpenDialog(destination)
    if (parent.canceled || !parent.filePaths[0]) return null
    if (idle(sender) !== service) throw new Error('开发会话已切换，请重新导入')
    return service.importPackage(selected.filePaths[0], parent.filePaths[0])
  })
  handle('close', async (sender, session) => { const service = idle(sender); service.assert(session); await service.close() })
  handle('state', (sender, session) => state(sender).service.state(session))
  handle('read', (sender, session, file) => state(sender).service.read(session, file))
  handle('write', (sender, session, file, content, revision) => idle(sender).write(session, file, content, revision))
  handle('remove', (sender, session, file, revision) => idle(sender).remove(session, file, revision))
  handle('importAssets', async (sender, session) => {
    const service = idle(sender); service.assert(session)
    const owner = BrowserWindow.fromWebContents(sender), options = { title: '导入开发资源', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: '图片、字体与文本', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'woff2', 'json', 'txt'] }] }
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return selected.canceled ? null : service.importAssets(session, selected.filePaths)
  })
  handle('build', (sender, session) => idle(sender).build(session))
  handle('preview', async (sender, session, page, dark, readOnly) => {
    const result = await state(sender).service.preview(session, page, dark, readOnly, await host.appearance?.())
    for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key)
    while (previews.size >= 12) previews.delete(previews.keys().next().value!)
    previews.set(result.token, { owner: sender.id, session, buildId: result.buildId, html: result.html, expires: Date.now() + 10 * 60_000 })
    return { ...result, html: '' }
  })
  handle('debug', (sender, session, input: DeveloperDebugInput) => idle(sender).debug(session, input))
  handle('previewInvoke', (sender, session, channel, args, readOnly) => idle(sender).previewInvoke(session, channel, args, readOnly))
  handle('cancel', async (sender, session) => { const service = state(sender).service; service.assert(session); await service.cancel() })
  handle('drafts', (sender, session) => state(sender).service.drafts(session))
  handle('saveDrafts', (sender, session, drafts) => state(sender).service.saveDrafts(session, drafts))
  handle('restoreCheckpoint', (sender, session) => idle(sender).restoreCheckpoint(session))
  handle('export', async (sender, session) => {
    const service = idle(sender), artifact = await service.artifact(session)
    const owner = BrowserWindow.fromWebContents(sender), options = { title: '导出扩展包', defaultPath: path.basename(artifact.file), filters: [{ name: 'ModMind 扩展包', extensions: [artifact.build.manifest.studios?.length ? 'mmstudio' : 'mmfeature'] }] }
    const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    service.assert(session)
    if (selected.canceled || !selected.filePath) return null
    if (path.resolve(selected.filePath) !== path.resolve(artifact.file)) await fs.copyFile(artifact.file, selected.filePath)
    return { path: selected.filePath, bytes: artifact.build.bytes, buildId: artifact.build.id }
  })
  handle('conversations', (sender, session) => state(sender).service.conversations(session))
  handle('saveConversation', (sender, session, conversation) => state(sender).service.saveConversation(session, conversation))
  handle('deleteConversation', (sender, session, id) => idle(sender).deleteConversation(session, id))
  const capture = async (service: DeveloperService, session: string, page?: string, dark?: boolean): Promise<unknown> => {
    const preview = await service.preview(session, page, dark, false, await host.appearance?.())
    const owner = [...sessions.entries()].find(([, entry]) => entry.service === service)?.[0]
    if (owner !== undefined) previews.set(preview.token, { owner, session, buildId: preview.buildId, html: preview.html, expires: Date.now() + 60_000 })
    const window = new BrowserWindow({ show: false, skipTaskbar: true, width: 1080, height: 680, webPreferences: { preload: path.join(kit, 'preview-capture-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
    captures.set(window.webContents.id, { service, session })
    const unsubscribe = service.onPreviewEvent((channel, args) => { if (!window.isDestroyed()) window.webContents.send('developer:captureEvent', channel, args) })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    try {
      await window.loadURL(preview.url!)
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
      await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(window.__devErrors?.length)return reject(Error(window.__devErrors.join('\\n')));if(window.__devReady&&!window.__devPending&&Date.now()-window.__devLastRequest>250)return resolve(true);if(Date.now()-start>30000)return reject(Error('预览尚未完成，无法验证截图'));setTimeout(check,50)};check()})`)
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      service.assert(session)
      const image = await new Promise<{ png: Buffer; dataUrl: string }>((resolve, reject) => {
        const contents = window.webContents
        let frames = 0
        const timer = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error('预览尚未完成绘制，请重试截图')) }, 10000)
        const painted = (_event: unknown, _rect: unknown, image: import('electron').NativeImage): void => {
          if (image.isEmpty()) return
          if (++frames < 3) { setTimeout(() => { if (!contents.isDestroyed()) contents.invalidate() }, 32); return }
          clearTimeout(timer); contents.removeListener('paint', painted); resolve({ png: image.toPNG(), dataUrl: image.toDataURL() })
        }
        contents.on('paint', painted); contents.invalidate()
      })
      const output = path.join(service.assert(session).root, '.modmind-dev', 'preview.png')
      await fs.writeFile(output, image.png)
      return { status: 'completed', buildId: preview.buildId, simulatedProject: true, path: output, dataUrl: image.dataUrl }
    } finally { unsubscribe(); captures.delete(window.webContents.id); window.destroy() }
  }
  handle('runAi', async (sender, session: string, conversationId: string, prompt: string, backend: AgentSettings['codingBackend'], selection?: AiModelSelection) => {
    const entry = state(sender), project = entry.service.assert(session)
    if (entry.ai) throw new Error('开发工作台已有 AI 任务')
    if (!/^[0-9a-f-]{36}$/.test(conversationId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000 || !['codex', 'quota'].includes(backend)) throw new Error('开发对话参数无效')
    const controller = new AbortController(); entry.ai = controller
    const runId = randomUUID()
    const emit = (kind: string, content: string, identity?: Record<string, unknown>) => { if (!sender.isDestroyed()) sender.send('developer:ai', { session, conversationId, event: { kind, content, time: new Date().toISOString(), runId, projectPath: project.root, ...identity } }) }
    let conversation: DeveloperConversation = (await entry.service.conversations(session)).find(item => item.id === conversationId) ?? { id: conversationId, title: prompt.slice(0, 36), prompt: '', timeline: [], updatedAt: new Date().toISOString() }
    const aiProject: ProjectInfo = { name: project.name, path: project.root, kind: 'developer', loader: 'extension', minecraftVersion: '1', namespace: project.id, createdAt: project.createdAt }
    const bridge = developerBridge(entry.service, session, (page, dark) => capture(entry.service, session, page, dark))
    let finalAnswer = ''
    let deliveredFinal = false
    try {
      await entry.service.checkpoint(session)
      const result = await host.run({ kind: 'codex', project: aiProject, prompt, signal: controller.signal, runId, bridge,
        sessionScope: 'developer/' + conversationId, sessionLane: backend, sessionId: conversation.nativeSessions?.[backend], resumeSession: Boolean(conversation.nativeSessions?.[backend]),
        systemPrompt: bridge.workspaceContext, onOutput: (kind, content, identity) => { if (kind === 'response' && identity?.phase !== 'commentary') deliveredFinal = true; emit(kind, content, identity) },
        onProgress: (title, detail) => emit('tool', title + (detail ? '\n' + detail : '')),
        onSessionId: id => { conversation.nativeSessionId = id; conversation.nativeSessions = { ...conversation.nativeSessions, [backend]: id } },
        onUsage: usage => emit('usage', '', { usage })
      }, backend, sender, selection)
      if (result.sessionId) { conversation.nativeSessionId = result.sessionId; conversation.nativeSessions = { ...conversation.nativeSessions, [backend]: result.sessionId } }
      finalAnswer = result.finalAnswer?.text ?? result.summary
      if (finalAnswer && !deliveredFinal) emit('response', finalAnswer, { phase: 'final_answer' })
    } catch (error) { emit('error', controller.signal.aborted ? '开发任务已停止，已保存的修改已保留' : error instanceof Error ? error.message : String(error), { terminal: true }); throw error }
    finally {
      const latest = (await entry.service.conversations(session).catch(() => [])).find(item => item.id === conversationId)
      const timeline = latest?.timeline ?? conversation.timeline
      if (finalAnswer && !timeline.some((item: any) => ['answer', 'response'].includes(item.kind) && item.content === finalAnswer)) timeline.push({ id: 'developer-final-' + runId, kind: 'answer', content: finalAnswer, time: new Date().toISOString(), runId })
      conversation = { ...conversation, ...latest, timeline, nativeSessionId: conversation.nativeSessionId, nativeSessions: conversation.nativeSessions, updatedAt: new Date().toISOString() }
      await entry.service.saveConversation(session, conversation).catch(() => undefined)
      entry.ai = null
    }
  })
  handle('stopAi', async (sender, session) => { const entry = state(sender); entry.service.assert(session); entry.ai?.abort(); await entry.service.cancel() })
  app.on('before-quit', () => { for (const entry of sessions.values()) { entry.ai?.abort(); void entry.service.close() } })
}
