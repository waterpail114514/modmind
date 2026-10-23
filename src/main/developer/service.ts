import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process'
import type { DeveloperBuild, DeveloperConversation, DeveloperDebugInput, DeveloperDebugResult, DeveloperFile, DeveloperPreview, DeveloperProject, DeveloperState, DeveloperText } from '../../shared/developerWorkbench'
import { developerTemplate } from './templates'
import { prepareFeaturePlugin } from '../featurePluginPackage'
import { themeCssVariables, type AppAppearance } from '../../shared/appTheme'
import { runtimePlatformInfo } from '../../shared/platform'
import { scopedFilePath } from '../scopedFilePath'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const excluded = new Set(['.git', '.modmind', '.modmind-dev', 'node_modules'])
const readonly = (file: string): boolean => { const normalized = file.toLowerCase(); return normalized.startsWith('sdk/') || normalized.startsWith('reference/') || normalized === 'modmind.dev.json' }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const previewBaseCss = `*{box-sizing:border-box}body{margin:0;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--theme-text);background:var(--theme-panel)}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.6}.primary-button,.secondary-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px;padding:6px 12px;border-radius:6px;border:1px solid var(--theme-line);background:var(--theme-panel);color:var(--theme-text)}.primary-button{background:var(--theme-action);color:var(--theme-on-action);border-color:transparent}.inline-error{color:var(--theme-danger);white-space:pre-wrap}#root{height:100vh;width:100%}body.developer-preview-body{display:block;height:100vh;width:100%;overflow:hidden}#root>.keep-alive-route{height:100%;min-height:0}.settings-section{padding:20px}`

export class DeveloperService {
  project: DeveloperProject | null = null
  private buildResult: DeveloperBuild | null = null
  private buildWorker: Worker | null = null
  private runtime: ChildProcess | null = null
  private runtimeBuild = ''
  private runtimeStopping: Promise<void> = Promise.resolve()
  private testProject = ''
  private pendingRuntime = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private busy = false
  private building = false
  private buildAbort: AbortController | null = null
  private mutationTail: Promise<unknown> = Promise.resolve()
  private runtimeStarting: Promise<void> | null = null
  private previewListeners = new Set<(channel: string, args: unknown[]) => void>()
  onPreviewEvent(callback: (channel: string, args: unknown[]) => void): () => void { this.previewListeners.add(callback); return () => this.previewListeners.delete(callback) }
  constructor(readonly kit: string, readonly userData: string, private application?: { path: string; packaged: boolean; dependencyRoots: string[] }) {}
  private get fileLimit(): number { return (this.project?.sourceMode === 'package' ? 128 : 4) * 1024 * 1024 }
  private get totalLimit(): number { return (this.project?.sourceMode === 'package' ? 128 : 32) * 1024 * 1024 }

  assert(session: string): DeveloperProject {
    if (!this.project || session !== this.project.session) throw new Error('开发工程已切换，请刷新后重试')
    return this.project
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.catch(() => undefined)
    return result
  }
  private relative(file: string): string {
    if (typeof file !== 'string' || !file || file.length > 240 || file.includes('\\') || path.isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part) || /[. ]$/.test(part) || excluded.has(part.toLowerCase()))) throw new Error('文件路径必须位于开发工程内')
    return file
  }
  private async filePath(session: string, file: string): Promise<string> {
    const project = this.assert(session), relative = this.relative(file)
    let target = project.root
    for (const part of relative.split('/')) {
      target = path.join(target, part)
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat?.isSymbolicLink()) throw new Error('开发工程不支持符号链接：' + relative)
    }
    return target
  }
  async recent(): Promise<Omit<DeveloperProject, 'session'>[]> {
    const entries = await fs.readFile(path.join(this.userData, 'developer-recent.json'), 'utf8').then(JSON.parse).catch(() => [])
    return Array.isArray(entries) ? entries.slice(0, 20) : []
  }
  private async remember(project: DeveloperProject): Promise<void> {
    const { session: _session, ...record } = project
    const recent = await this.recent()
    await fs.mkdir(this.userData, { recursive: true })
    await fs.writeFile(path.join(this.userData, 'developer-recent.json'), JSON.stringify([record, ...recent.filter(item => item.root.toLowerCase() !== record.root.toLowerCase())].slice(0, 20)))
  }
  async create(parent: string, input: { id: string; name: string; kind: 'feature' | 'studio' }): Promise<DeveloperState> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.id) || !input.name?.trim() || input.name.length > 80 || !['feature', 'studio'].includes(input.kind)) throw new Error('请填写有效的包 ID、名称和类型')
    const root = path.join(await fs.realpath(parent), input.id)
    await fs.mkdir(root) // Never merge or replace an existing directory.
    const project: Omit<DeveloperProject, 'session'> = { format: 'modmind-developer', version: 1, id: input.id, name: input.name.trim(), kind: input.kind, createdAt: new Date().toISOString(), root }
    const files = { ...developerTemplate(input.id, project.name, input.kind), 'modmind.dev.json': JSON.stringify(project, null, 2) + '\n', 'sdk/index.d.ts': await fs.readFile(path.join(this.kit, 'sdk.d.ts'), 'utf8') }
    for (const [file, content] of Object.entries(files)) { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' }) }
    await fs.mkdir(path.join(root, 'reference'))
    for (const name of ['developer-workbench.zh-CN.md', 'extensions-development.zh-CN.md', 'mmfeature-development.zh-CN.md', 'mmstudio-development.zh-CN.md', 'design-spec.zh-CN.md', 'theme-system.zh-CN.md']) await fs.copyFile(path.join(this.kit, name), path.join(root, 'reference', name))
    return this.open(root)
  }
  async importPackage(archive: string, parent: string): Promise<DeveloperState> {
    if (this.busy || this.building) throw new Error('请先停止当前开发任务')
    if (!['.mmfeature', '.mmstudio'].includes(path.extname(archive).toLowerCase())) throw new Error('请选择 .mmfeature 功能包或 .mmstudio 工作台包')
    // Read and verify bytes only; native package code is not activated by import.
    const prepared = await prepareFeaturePlugin(archive).catch(error => { throw new Error('扩展包无法导入，请检查文件是否完整且兼容当前版本。\n' + errorText(error)) })
    const { files: _checksums, ...manifest } = prepared.manifest
    const files = new Map(prepared.files)
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
    files.set('sdk/index.d.ts', await fs.readFile(path.join(this.kit, 'sdk.d.ts')))
    files.set('README.md', Buffer.from(`# ${manifest.name}\n\n从发布包导入的独立副本。编辑 main.cjs、renderer.js、renderer.css 和 manifest.json，然后预览、调试和导出。\n\n包内的 JavaScript 已编译；原始 TypeScript/TSX 未包含在发布包中，不会自动还原。导入包使用独立 Electron 兼容宿主预览；依赖包需要先安装，外部游戏数据与服务凭据需另行准备。\n`))
    for (const name of ['developer-workbench.zh-CN.md', 'extensions-development.zh-CN.md', 'mmfeature-development.zh-CN.md', 'mmstudio-development.zh-CN.md', 'design-spec.zh-CN.md', 'theme-system.zh-CN.md']) files.set('reference/' + name, await fs.readFile(path.join(this.kit, name)))
    if (files.size + 1 > 512 || [...files.values()].reduce((size, bytes) => size + bytes.length, 0) > 128 * 1024 * 1024) throw new Error('导入内容超过开发工程限制：512 个文件、合计 128 MiB')
    for (const [name, bytes] of files) {
      this.relative(name)
      if (bytes.length > 128 * 1024 * 1024) throw new Error('导入文件超过 128 MiB：' + name)
    }
    const directory = await fs.realpath(parent)
    let root = ''
    for (let index = 0; index < 100; index++) {
      const candidate = path.join(directory, manifest.id + (index ? '-import' + (index > 1 ? '-' + index : '') : ''))
      try { await fs.mkdir(candidate); root = candidate; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (!root) throw new Error('同名导入工程过多，请选择其他保存位置')
    const project: Omit<DeveloperProject, 'session'> = { format: 'modmind-developer', version: 1, id: manifest.id, name: manifest.name, kind: manifest.studios?.length ? 'studio' : 'feature', sourceMode: 'package', createdAt: new Date().toISOString(), root }
    files.set('modmind.dev.json', Buffer.from(JSON.stringify(project, null, 2) + '\n'))
    try {
      if ([...files.values()].reduce((size, bytes) => size + bytes.length, 0) > 128 * 1024 * 1024) throw new Error('导入内容超过开发工程限制：合计 128 MiB')
      for (const [file, bytes] of files) { const target = path.join(root, ...file.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }) }
    } catch (error) {
      const relative = path.relative(directory, root)
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && await fs.realpath(root) === root && !(await fs.lstat(root)).isSymbolicLink()) await fs.rm(root, { recursive: true, force: true })
      throw error
    }
    return this.open(root)
  }
  async open(directory: string): Promise<DeveloperState> {
    if (this.busy || this.building) throw new Error('请先停止当前开发任务')
    const root = await fs.realpath(directory)
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('请选择实际开发目录')
    const metadata = path.join(root, 'modmind.dev.json')
    if ((await fs.lstat(metadata)).isSymbolicLink()) throw new Error('工程配置不能为链接')
    const project = JSON.parse(await fs.readFile(metadata, 'utf8'))
    if (project.format !== 'modmind-developer' || project.version !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(project.id) || !['feature', 'studio'].includes(project.kind) || typeof project.name !== 'string' || project.sourceMode !== undefined && project.sourceMode !== 'package') throw new Error('请选择有效的 ModMind 开发工程')
    await this.close()
    this.project = { ...project, root, session: randomUUID() }; this.buildResult = null
    await this.ensureInternal(root)
    await this.remember(this.project!)
    return this.state(this.project!.session)
  }
  private async ensureInternal(root: string): Promise<void> {
    const target = path.join(root, '.modmind-dev')
    const stat = await fs.lstat(target).catch(() => null)
    if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) throw new Error('开发缓存目录不可用')
    await fs.mkdir(target, { recursive: true })
    for (const name of ['builds', 'conversations', 'test-projects']) {
      const directory = path.join(target, name), stat = await fs.lstat(directory).catch(() => null)
      if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) throw new Error('开发缓存目录不可用：' + name)
      await fs.mkdir(directory, { recursive: true })
    }
  }
  async files(session: string): Promise<DeveloperFile[]> {
    const project = this.assert(session), files: DeveloperFile[] = []
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (excluded.has(entry.name.toLowerCase())) continue
        const relative = prefix + entry.name
        if (entry.isSymbolicLink()) throw new Error('开发工程包含不支持的链接：' + relative)
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + '/')
        else if (entry.isFile()) {
          if (files.length >= 512) throw new Error('第一版支持最多 512 个开发文件，请移出无关内容')
          const bytes = (await fs.stat(path.join(directory, entry.name))).size
          if (bytes > this.fileLimit) throw new Error('开发文件超过当前工程的体积限制：' + relative)
          files.push({ path: relative, bytes, readOnly: readonly(relative) })
        }
      }
    }
    await visit(project.root)
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }
  async state(session: string): Promise<DeveloperState> {
    const project = this.assert(session), files = await this.files(session)
    const manifest = await this.read(session, 'manifest.json').then(value => JSON.parse(value.content)).catch(() => null)
    return { project, files, manifest, build: this.buildResult }
  }
  async read(session: string, file: string): Promise<DeveloperText> {
    const target = await this.filePath(session, file), stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > Math.min(this.fileLimit, 16 * 1024 * 1024)) throw new Error('文件过大，不能在文本编辑器中打开；二进制资源会原样保留')
    const data = await fs.readFile(target)
    if (data.includes(0)) throw new Error('该文件为二进制资源，请在预览中使用')
    return { path: file, content: data.toString('utf8'), revision: hash(data) }
  }
  async readTest(session: string, file: string): Promise<DeveloperText> {
    this.assert(session)
    if (!this.testProject) throw new Error('尚未创建测试项目，请先运行调试')
    const relative = this.relative(file)
    let target = this.testProject
    for (const part of ['', ...relative.split('/')]) {
      target = path.join(target, part)
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('测试文件不支持链接')
    }
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('测试文件大小或类型不支持')
    const data = await fs.readFile(target)
    return { path: relative, content: data.toString('utf8'), revision: hash(data) }
  }
  async write(session: string, file: string, content: string, revision: string | null): Promise<DeveloperText> {
    if (typeof content !== 'string') throw new Error('文件内容须为文本')
    await this.writeData(session, file, Buffer.from(content, 'utf8'), revision)
    return { path: file, content, revision: hash(content) }
  }
  private async writeData(session: string, file: string, content: Buffer, revision: string | null): Promise<void> {
    await this.serial(async () => {
      if (readonly(file)) throw new Error('SDK 与协议参考由应用管理')
      if (content.length > this.fileLimit) throw new Error('文件内容超过当前工程的体积限制')
      const target = await this.filePath(session, file)
      const current = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if ((current ? hash(current) : null) !== revision) throw new Error('文件已被其他操作修改，请重新读取后合并；当前草稿已保留')
      const files = await this.files(session)
      if (!current && files.length >= 512) throw new Error('开发文件已达到 512 个，请先移除无关文件')
      if (files.reduce((total, file) => total + file.bytes, 0) - (current?.length ?? 0) + content.length > this.totalLimit) throw new Error('开发内容超过当前工程的体积限制')
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = target + '.' + randomUUID() + '.tmp'
      await fs.writeFile(temporary, content, { flag: 'wx' })
      try { await fs.rename(temporary, target) } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      this.stopRuntime()
    })
  }
  async remove(session: string, file: string, revision: string): Promise<void> {
    await this.serial(async () => {
      if (readonly(file) || ['main.ts', 'renderer.tsx', 'main.cjs', 'renderer.js', 'renderer.css', 'manifest.json'].includes(file)) throw new Error('工程入口和 SDK 不可删除')
      const target = await this.filePath(session, file)
      if (hash(await fs.readFile(target)) !== revision) throw new Error('文件已变化，请重新读取')
      await fs.unlink(await this.filePath(session, file)); this.stopRuntime()
    })
  }
  async importAssets(session: string, files: string[]): Promise<DeveloperState> {
    if (files.length > 32) throw new Error('一次最多导入 32 个资源')
    if ((await this.files(session)).length + files.length > 512) throw new Error('导入后文件数将超过 512 个')
    for (const source of files) {
      const stat = await fs.lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || !/\.(png|jpe?g|svg|webp|woff2|json|txt)$/i.test(source)) throw new Error('请选择 4 MiB 以内的图片、字体或文本资源')
      const name = path.basename(source), extension = path.extname(name), base = name.slice(0, -extension.length)
      let relative = 'assets/' + name
      for (let suffix = 2; await fs.stat(await this.filePath(session, relative)).catch(() => null); suffix++) relative = `assets/${base}-${suffix}${extension}`
      const target = await this.filePath(session, relative)
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL)
    }
    return this.state(session)
  }
  async snapshot(session: string): Promise<{ sources: { path: string; base64: string }[]; revision: string }> {
    await this.mutationTail
    const files = await this.files(session), sources: { path: string; base64: string }[] = []
    let bytes = 0
    for (const file of files) {
      const data = await fs.readFile(await this.filePath(session, file.path))
      if ((bytes += data.length) > this.totalLimit) throw new Error('开发内容超过当前工程的体积限制')
      sources.push({ path: file.path, base64: data.toString('base64') })
    }
    return { sources, revision: hash(JSON.stringify(sources)) }
  }
  async build(session: string): Promise<DeveloperBuild> {
    if (this.building) throw new Error('正在构建，请等待完成或停止')
    this.building = true
    const controller = new AbortController(); this.buildAbort = controller
    try {
    const project = this.assert(session)
    await this.ensureInternal(project.root)
    const snapshot = await this.snapshot(session)
    controller.signal.throwIfAborted()
    if (this.buildResult?.sourceRevision === snapshot.revision) {
      const build = this.buildResult, directory = path.join(project.root, '.modmind-dev', 'builds', build.id, 'package')
      const valid = await Promise.all(Object.entries(build.manifest.files).map(async ([file, revision]) => hash(await fs.readFile(path.join(directory, file))) === revision)).then(values => values.every(Boolean)).catch(() => false)
      if (valid) return build
      this.buildResult = null
    }
    this.stopRuntime()
    const worker = new Worker(path.join(this.kit, 'build-worker.cjs'), { workerData: { root: project.root, kit: this.kit, kind: project.kind, sourceMode: project.sourceMode, sources: snapshot.sources, sourceRevision: snapshot.revision }, env: { ...process.env, ESBUILD_BINARY_PATH: path.join(this.kit, process.platform === 'win32' ? 'esbuild.exe' : 'esbuild') } })
    this.buildWorker = worker
    try {
      const result = await new Promise<DeveloperBuild>((resolve, reject) => {
        const timeout = setTimeout(() => { void worker.terminate(); reject(new Error('构建超过 60 秒，请检查工程后重试')) }, 60_000)
        worker.once('message', value => { clearTimeout(timeout); value.ok ? resolve(value.result) : reject(new Error((value.diagnostics || []).map((item: any) => `${item.file || '工程'}${item.line ? ':' + item.line : ''}：${item.message}`).join('\n') || value.error)) })
        worker.once('error', error => { clearTimeout(timeout); reject(error) })
        worker.once('exit', () => { clearTimeout(timeout); reject(new Error('构建已停止')) })
      })
      this.assert(session)
      if (project.sourceMode === 'package') await prepareFeaturePlugin(path.join(project.root, '.modmind-dev', 'builds', result.id, result.manifest.id + (project.kind === 'studio' ? '.mmstudio' : '.mmfeature')))
      this.buildResult = result
      await fs.writeFile(path.join(project.root, '.modmind-dev', 'last-build.json'), JSON.stringify(result))
      await this.pruneBuilds(project.root, result.id)
      return result
    } finally { if (this.buildWorker === worker) this.buildWorker = null; await worker.terminate() }
    } finally { this.building = false; if (this.buildAbort === controller) this.buildAbort = null }
  }
  private async pruneBuilds(root: string, current: string): Promise<void> {
    const directory = path.join(root, '.modmind-dev', 'builds')
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)).map(async entry => ({ name: entry.name, time: (await fs.stat(path.join(directory, entry.name))).mtimeMs })))
    for (const item of candidates.sort((a, b) => b.time - a.time).slice(3)) if (item.name !== current) await fs.rm(path.join(directory, item.name), { recursive: true, force: true })
  }
  private async currentBuild(session: string): Promise<DeveloperBuild> {
    this.assert(session)
    if (!this.buildResult || this.buildResult.sourceRevision !== (await this.snapshot(session)).revision) throw new Error('源码已变化，请先重新构建预览')
    return this.buildResult
  }
  async preview(session: string, page?: string, dark = false, readOnly = false, appearance?: AppAppearance): Promise<DeveloperPreview> {
    const project = this.assert(session), build = await this.currentBuild(session)
    await this.ensureTestProject(session, build)
    if (project.sourceMode === 'package' && this.application) await this.startRuntime(session, build)
    const directory = path.join(project.root, '.modmind-dev', 'builds', build.id, 'package')
    const [runtime, api, baseCss, code, css] = await Promise.all([
      fs.readFile(path.join(this.kit, 'preview.js'), 'utf8'), fs.readFile(path.join(this.kit, 'preview-api.js'), 'utf8'), fs.readFile(path.join(this.kit, 'preview.css'), 'utf8'),
      fs.readFile(path.join(directory, 'renderer.js'), 'utf8'), fs.readFile(path.join(directory, 'renderer.css'), 'utf8')])
    const token = randomUUID(), pages = [...(build.manifest.views ?? []), ...(build.manifest.settings ?? [])].map(view => ({ id: view.id, label: view.label }))
    if (page && !pages.some(item => item.id === page)) throw new Error('预览页面未声明：' + page)
    const demo = { name: '示例项目', path: this.testProject, loader: 'development', minecraftVersion: '1', namespace: 'devtest', kind: 'development', createdAt: project.createdAt }
    const metadata = this.testProject ? await fs.readFile(path.join(this.testProject, 'modmind.project.json'), 'utf8').then(JSON.parse).catch(() => demo) : demo
    const globals = JSON.stringify({ token, manifest: build.manifest, page: page ?? pages[0]?.id, dark, project: metadata, appearance, platform: runtimePlatformInfo(process.platform, process.arch, !!this.application?.packaged) }).replaceAll('<', '\\u003c')
    const script = (value: string): string => value.replace(/<\/script/gi, '<\\/script')
    const theme = Object.entries(themeCssVariables(appearance?.themePreset, dark ? 'dark' : 'light', appearance?.customThemeColors)).map(([key, value]) => `${key}:${value}`).join(';')
    const resourceBase = 'modmind-dev-preview://p-' + hash(project.root).slice(0, 16) + '/' + token + '/'
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: modmind-dev-preview:; worker-src blob:; style-src 'unsafe-inline' modmind-dev-preview:; img-src data: blob: modmind-dev-preview:; font-src data: modmind-dev-preview:; connect-src modmind-dev-preview:; frame-src modmind-dev-preview:"><style>${baseCss}\n:root{${theme};--surface:var(--theme-surface);--surface-alt:var(--theme-panel);--line:var(--theme-line);--muted:var(--theme-muted)}${previewBaseCss}\n${css.replaceAll('modmind-feature://', resourceBase + 'features/').replace(/<\/style/gi, '<\\/style')}</style></head><body class="app-shell developer-preview-body ${dark ? 'dark-mode' : ''}"><div id="root"></div><script>const c=${globals};window.__devToken=c.token;window.__devManifest=c.manifest;window.__devPage=c.page;window.__devDark=c.dark;window.__devProject=c.project;window.__devAppearance=c.appearance;window.__devPlatform=c.platform;window.__devResourceBase=${JSON.stringify(resourceBase)};</script><script>${script(runtime)}</script><script>${script(api)}</script><script>${script(code.replaceAll('modmind-feature://', resourceBase + 'features/'))}
window.__devRendererLoaded();</script></body></html>`
    // Token is only a message correlation value; the parent also checks iframe identity.
    return { buildId: build.id, html, pages, token, readOnly, url: resourceBase } as DeveloperPreview
  }
  private stopRuntime(reason = '调试进程已停止'): Promise<void> {
    const child = this.runtime
    this.runtime = null; this.runtimeBuild = ''
    for (const item of this.pendingRuntime.values()) { clearTimeout(item.timer); item.reject(new Error(reason)) }
    this.pendingRuntime.clear()
    if (child && child.exitCode === null && child.signalCode === null) {
      this.runtimeStopping = new Promise<void>(resolve => {
        const killTimer = setTimeout(() => child.kill(), 500)
        const timer = setTimeout(resolve, 5000)
        child.once('close', () => { clearTimeout(timer); clearTimeout(killTimer); resolve() })
        try { child.send({ id: 'shutdown', request: { operation: 'dispose' } }, () => undefined) } catch { child.kill() }
      })
    }
    return this.runtimeStopping
  }
  private async ensureTestProject(session: string, build: DeveloperBuild): Promise<void> {
    if (this.testProject) return
    const project = this.assert(session)
    this.testProject = path.join(project.root, '.modmind-dev', 'test-projects', randomUUID())
    await fs.mkdir(this.testProject, { recursive: true })
    if (project.kind === 'studio') return
    const scope = build.manifest
    const studioId = scope.studioIds?.[0] ?? scope.views?.find(view => view.studioIds?.length)?.studioIds?.[0] ?? 'minecraft-mod'
    const kind = studioId === 'minecraft-modpack' ? 'modpack' : studioId === 'minecraft-server-plugin' ? 'server-plugin' : 'mod'
    const loader = scope.loaders?.[0] ?? scope.views?.find(view => view.loaders?.length)?.loaders?.[0] ?? (kind === 'server-plugin' ? 'paper' : 'fabric')
    await fs.writeFile(path.join(this.testProject, 'modmind.project.json'), JSON.stringify({ name: '示例项目', path: this.testProject, kind, studioId, loader, minecraftVersion: '1.20.1', namespace: 'devtest', createdAt: project.createdAt }))
    if (kind === 'mod') await fs.mkdir(path.join(this.testProject, 'src/main/resources/assets/devtest'), { recursive: true })
  }
  async previewInvoke(session: string, channel: string, args: unknown[], readOnly = false): Promise<DeveloperDebugResult> {
    if (typeof channel !== 'string' || !Array.isArray(args) || typeof readOnly !== 'boolean' || JSON.stringify(args).length > 32 * 1024 * 1024) throw new Error('预览调用参数无效')
    const allowed = ['feature-plugins:catalog', 'feature-plugins:list', 'feature-plugins:invoke', 'project:current', 'sounds:renderComplete']
    if (!allowed.includes(channel)) throw new Error('独立预览未开放此宿主操作：' + channel)
    const work = (async () => {
      const build = await this.currentBuild(session)
      await this.startRuntime(session, build)
      const value = await this.runtimeRequest({ operation: 'host-api', channel, args, readOnly })
      this.assert(session)
      return { status: 'completed' as const, buildId: build.id, result: value.result, logs: value.logs ?? [], projectPath: this.testProject, events: value.events ?? [] }
    })()
    return work
  }
  async previewResource(session: string, buildId: string, id: string, name: string): Promise<Buffer> {
    const project = this.assert(session), build = await this.currentBuild(session)
    if (build.id !== buildId || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !name.startsWith('assets/') || name.includes('\\') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('预览资源已失效或路径无效')
    const base = id === build.manifest.id ? path.join(project.root, '.modmind-dev/builds', build.id, 'package') : path.join(project.root, '.modmind-dev/host-profile/feature-plugins', id)
    const manifest = id === build.manifest.id ? build.manifest : JSON.parse(await fs.readFile(path.join(base, 'manifest.json'), 'utf8'))
    if (!manifest.files?.[name]) throw new Error('预览资源未声明')
    const real = await fs.realpath(path.join(base, name)), relative = path.relative(await fs.realpath(base), real)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('预览资源超出包目录')
    const bytes = await fs.readFile(real)
    if (hash(bytes) !== manifest.files[name]) throw new Error('预览资源已损坏，请重新构建')
    return bytes
  }
  private async startRuntime(session: string, build: DeveloperBuild): Promise<void> {
    if (this.runtimeStarting) { await this.runtimeStarting; return this.startRuntime(session, build) }
    if (this.runtime && this.runtimeBuild === build.id) return
    const starting = this.launchRuntime(session, build)
    this.runtimeStarting = starting
    try { await starting } finally { if (this.runtimeStarting === starting) this.runtimeStarting = null }
  }
  private async launchRuntime(session: string, build: DeveloperBuild): Promise<void> {
    if (this.runtime && this.runtimeBuild === build.id) return
    await this.stopRuntime()
    const project = this.assert(session)
    await this.ensureTestProject(session, build)
    const forkOptions: ForkOptions & { windowsHide: boolean } = { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, serialization: 'advanced' }
    let child: ChildProcess
    if (project.sourceMode === 'package' && this.application) {
      const profile = await scopedFilePath(project.root, '.modmind-dev/host-profile')
      await fs.mkdir(profile, { recursive: true })
      const copied = new Set<string>([build.manifest.id])
      const copyDependency = async (id: string): Promise<void> => {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('功能包依赖 ID 无效')
        if (copied.has(id)) return
        copied.add(id)
        let source = ''
        for (const base of this.application!.dependencyRoots) if (await fs.stat(path.join(base, id, 'manifest.json')).catch(() => null)) { source = path.join(base, id); break }
        if (!source) throw new Error('缺少预览依赖，请先安装：' + id)
        const metadata = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'))
        for (const dependency of metadata.dependencies ?? []) await copyDependency(dependency)
        const target = path.join(profile, 'feature-plugins', id)
        await fs.mkdir(target, { recursive: true })
        // Copy verified package files only, not a feature's cache, credentials or user data.
        for (const file of ['manifest.json', ...Object.keys(metadata.files ?? {})]) {
          if (!file || file.split('/').some(part => part === '..' || part === '.') || path.isAbsolute(file) || file.includes('\\')) throw new Error('依赖资源路径无效')
          const bytes = await fs.readFile(path.join(source, file))
          if (file !== 'manifest.json' && hash(bytes) !== metadata.files[file]) throw new Error('预览依赖已损坏：' + id)
          const destination = await scopedFilePath(profile, 'feature-plugins/' + id + '/' + file)
          await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes)
        }
      }
      for (const dependency of build.manifest.dependencies ?? []) await copyDependency(dependency)
      const configFile = await scopedFilePath(profile, 'host.json')
      await fs.writeFile(configFile, JSON.stringify({ kit: this.kit, profile, application: this.application.path, pluginId: build.manifest.id }))
      const env: NodeJS.ProcessEnv = { ...process.env, MODMIND_DEVELOPER_HOST_CONFIG: configFile }
      delete env.ELECTRON_RUN_AS_NODE
      child = spawn(process.execPath, this.application.packaged ? [] : [this.application.path], { ...forkOptions, env })
    } else child = fork(path.join(this.kit, 'runtime.cjs'), [], forkOptions)
    this.runtime = child; this.runtimeBuild = build.id
    child.on('message', (message: any) => {
      if (message.type === 'renderer-event' && this.runtime === child) {
        for (const listener of this.previewListeners) listener(message.channel, message.args)
        return
      }
      const item = this.pendingRuntime.get(message.id)
      if (!item) return
      clearTimeout(item.timer); this.pendingRuntime.delete(message.id)
      if (message.ok) item.resolve(message)
      else { const error = new Error(message.error); if (message.stack) error.stack = message.stack; item.reject(error) }
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    child.on('error', error => { if (this.runtime === child) void this.stopRuntime(error.message) })
    child.on('exit', (code, signal) => { if (this.runtime === child) void this.stopRuntime('测试进程退出：' + (signal ?? code) + (stderr ? '\n' + stderr : '')) })
    try {
      await this.runtimeRequest({ operation: 'init', manifest: build.manifest, archive: path.join(project.root, '.modmind-dev', 'builds', build.id, build.manifest.id + (build.manifest.studios?.length ? '.mmstudio' : '.mmfeature')), directory: path.join(project.root, '.modmind-dev', 'builds', build.id, 'package'), projectPath: this.testProject, userDataDir: path.join(project.root, '.modmind-dev', 'test-data') })
    } catch (error) { await this.stopRuntime(); throw error }
  }
  private runtimeRequest(request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { this.stopRuntime(); reject(new Error('调试超过 30 秒，已停止测试进程')) }, 30_000)
      this.pendingRuntime.set(id, { resolve, reject, timer })
      this.runtime?.send({ id, request }, error => { if (error) { clearTimeout(timer); this.pendingRuntime.delete(id); reject(error) } })
    })
  }
  async debug(session: string, input: DeveloperDebugInput): Promise<DeveloperDebugResult> {
    if (!input || typeof input !== 'object' || !['inspect', 'action', 'tool', 'create-studio'].includes(input.operation) || Object.keys(input).some(key => !['operation', 'name', 'input', 'readOnly'].includes(key)) || input.readOnly !== undefined && typeof input.readOnly !== 'boolean' || input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) || JSON.stringify(input).length > 1024 * 1024) throw new Error('调试参数无效；参数须为 1 MiB 以内的对象')
    if (this.busy) throw new Error('已有调试任务，请等待或停止')
    this.busy = true
    try {
      const build = await this.currentBuild(session)
      if (input.operation === 'create-studio') { this.stopRuntime(); this.testProject = '' }
      await this.startRuntime(session, build)
      let value: any
      if (input.operation === 'tool') {
        const initialize = await this.runtimeRequest({ operation: 'mcp', rpc: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'modmind-developer', version: '1' } } } })
        const catalog = await this.runtimeRequest({ operation: 'mcp', rpc: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } })
        if (!catalog.result.result?.tools?.some((tool: any) => tool.name === input.name)) throw new Error('MCP 工具未发现：' + input.name)
        const called = await this.runtimeRequest({ operation: 'mcp', readOnly: input.readOnly, rpc: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: input.name, arguments: input.input ?? {} } } })
        if (called.result.error || called.result.result?.isError) throw new Error(called.result.error?.message ?? called.result.result.content[0].text)
        value = { ...called, result: called.result.result.structuredContent, mcp: { initialize: initialize.result, catalog: catalog.result, response: called.result } }
      } else value = await this.runtimeRequest(input as unknown as Record<string, unknown>)
      this.assert(session)
      return { status: 'completed', buildId: build.id, result: value.result, logs: value.logs ?? [], projectPath: this.testProject, events: value.events ?? [], ...(value.mcp ? { mcp: value.mcp } : {}) } as DeveloperDebugResult
    } finally { this.busy = false }
  }
  async artifact(session: string): Promise<{ file: string; build: DeveloperBuild }> {
    const build = await this.currentBuild(session), project = this.assert(session)
    const file = path.join(project.root, '.modmind-dev', 'builds', build.id, build.manifest.id + (build.manifest.studios?.length ? '.mmstudio' : '.mmfeature'))
    const valid = await fs.lstat(file).then(async stat => !stat.isSymbolicLink() && hash(await fs.readFile(file)) === build.archiveSha256).catch(() => false)
    if (!valid) { this.buildResult = null; throw new Error('导出产物已变化，请重新构建') }
    return { file, build }
  }
  async conversations(session: string): Promise<DeveloperConversation[]> {
    const project = this.assert(session), directory = path.join(project.root, '.modmind-dev', 'conversations')
    const files = await fs.readdir(directory)
    const result: DeveloperConversation[] = []
    for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).slice(0, 100)) {
      const target = path.join(directory, file), stat = await fs.lstat(target)
      if (stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) continue
      const value = await fs.readFile(target, 'utf8').then(JSON.parse).catch(() => null)
      if (value && typeof value.title === 'string' && typeof value.prompt === 'string' && Array.isArray(value.timeline) && typeof value.updatedAt === 'string' && value.id === file.slice(0, -5)) result.push(value)
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async saveConversation(session: string, conversation: DeveloperConversation): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(conversation.id) || !Array.isArray(conversation.timeline) || JSON.stringify(conversation).length > 4 * 1024 * 1024) throw new Error('开发对话格式或大小无效')
    const project = this.assert(session)
    await this.ensureInternal(project.root)
    const target = path.join(project.root, '.modmind-dev', 'conversations', conversation.id + '.json')
    if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error('对话不能写入链接')
    const stored = await fs.readFile(target, 'utf8').then(JSON.parse).catch(() => null)
    await fs.writeFile(target, JSON.stringify({ ...conversation, nativeSessionId: conversation.nativeSessionId ?? stored?.nativeSessionId, nativeSessions: { ...stored?.nativeSessions, ...conversation.nativeSessions } }))
  }
  async deleteConversation(session: string, id: string): Promise<void> {
    const project = this.assert(session)
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('对话 ID 无效')
    await fs.unlink(path.join(project.root, '.modmind-dev', 'conversations', id + '.json'))
  }
  private async managedFile(session: string, name: string): Promise<string> {
    const project = this.assert(session)
    await this.ensureInternal(project.root)
    const target = path.join(project.root, '.modmind-dev', name)
    if ((await fs.lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error('开发数据不能写入链接')
    return target
  }
  async drafts(session: string): Promise<DeveloperText[]> {
    const file = await this.managedFile(session, 'editor-drafts.json')
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) return []
    if (stat.size > 32 * 1024 * 1024) throw new Error('草稿数据超过 32 MiB')
    const drafts = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(drafts)) throw new Error('开发草稿格式无效')
    return drafts
  }
  async saveDrafts(session: string, drafts: DeveloperText[]): Promise<void> {
    if (!Array.isArray(drafts) || drafts.length > 128) throw new Error('最多保存 128 个未保存文件草稿')
    for (const draft of drafts) if (readonly(this.relative(draft.path)) || typeof draft.content !== 'string' || typeof draft.revision !== 'string') throw new Error('开发草稿格式无效')
    const value = JSON.stringify(drafts)
    if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new Error('未保存草稿超过 32 MiB，请保存文件')
    await this.serial(async () => { await fs.writeFile(await this.managedFile(session, 'editor-drafts.json'), value) })
  }
  async checkpoint(session: string): Promise<void> {
    const snapshot = await this.snapshot(session)
    await fs.writeFile(await this.managedFile(session, 'ai-checkpoint.json'), JSON.stringify(snapshot))
  }
  async restoreCheckpoint(session: string): Promise<void> {
    const target = await this.managedFile(session, 'ai-checkpoint.json')
    const stat = await fs.stat(target).catch(() => null)
    if (!stat) throw new Error('当前工程还没有 AI 修改前的恢复点')
    if (stat.size > this.totalLimit * 1.5) throw new Error('恢复点大小无效')
    const checkpoint = JSON.parse(await fs.readFile(target, 'utf8'))
    if (!Array.isArray(checkpoint.sources) || checkpoint.sources.length > 512) throw new Error('恢复点格式无效')
    for (const source of checkpoint.sources) {
      this.relative(source.path)
      if (typeof source.base64 !== 'string') throw new Error('恢复点内容无效')
      if (Buffer.from(source.base64, 'base64').length > this.fileLimit) throw new Error('恢复点文件过大')
      await this.filePath(session, source.path)
    }
    const before = await this.snapshot(session)
    // Keep the inverse so repeated restore toggles the two recoverable states.
    const previous = new Map<string, { path: string; base64: string }>(checkpoint.sources.map((file: any) => [file.path, file]))
    const existing = new Map(before.sources.map(file => [file.path, file]))
    for (const file of checkpoint.sources) {
      if (readonly(file.path)) continue
      const original = existing.get(file.path)
      const data = Buffer.from(file.base64, 'base64')
      await this.writeData(session, file.path, data, original ? hash(Buffer.from(original.base64, 'base64')) : null)
    }
    for (const file of before.sources) if (!readonly(file.path) && !previous.has(file.path)) await this.remove(session, file.path, hash(Buffer.from(file.base64, 'base64')))
    await fs.writeFile(target, JSON.stringify(before))
    this.buildResult = null
  }
  async cancel(): Promise<void> { this.buildAbort?.abort(); if (this.buildWorker) await this.buildWorker.terminate(); await this.stopRuntime() }
  async close(): Promise<void> { await this.cancel(); await this.mutationTail; this.project = null; this.buildResult = null; this.testProject = '' }
}
