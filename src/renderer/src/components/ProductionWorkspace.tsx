import { SecretInput } from './SecretInput'
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  CircleAlert,
  CloudUpload,
  Download,
  FileJson,
  GitBranch,
  LoaderCircle,
  Music,
  PackageSearch,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  X
} from 'lucide-react'
import type {
  ContentKind,
  DependencyProject,
  ManagedDependency,
  ReleasePreflightResult,
  ReleasePublishResult,
  ReleaseSettings,
  TestMatrixResult,
  TestTarget
} from '../../../shared/production'
import type { ProjectInfo } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

type ProductionTab = 'dependencies' | 'content' | 'tests' | 'release'
type PublishTarget = 'modrinth' | 'curseforge' | 'github'

const contentKinds: Array<{ id: ContentKind; label: string }> = [
  { id: 'language', label: '语言文本' },
  { id: 'recipe-shaped', label: '有形配方' },
  { id: 'recipe-shapeless', label: '无序配方' },
  { id: 'item-tag', label: '物品标签' },
  { id: 'block-tag', label: '方块标签' },
  { id: 'loot-block', label: '方块掉落' },
  { id: 'advancement', label: '进度' },
  { id: 'data-json', label: '数据 JSON' },
  { id: 'asset-json', label: '资源 JSON' }
]

const testTargets: Array<{ id: TestTarget; label: string; detail: string }> = [
  { id: 'build', label: 'Gradle 构建', detail: '编译、资源处理与产物检查' },
  { id: 'client', label: '客户端启动', detail: '启动并稳定运行 20 秒' },
  { id: 'server', label: '专用服务器', detail: '启动并稳定运行 15 秒' },
  { id: 'gametest', label: 'GameTest', detail: '执行 Loader 提供的测试任务' }
]

const defaultRelease = (project: ProjectInfo): ReleaseSettings => ({
  version: '0.1.0',
  displayName: `${project.name} 0.1.0`,
  summary: '',
  changelog: '',
  autoBump: true,
  bumpMode: 'patch',
  channel: 'release',
  modrinthProjectId: '',
  curseForgeProjectId: '',
  githubRepository: ''
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function DependencyIcon({ url }: { url?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <span className="dependency-placeholder" aria-hidden="true"><PackageSearch size={19} /></span>
  return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

function DependenciesPane({ onFilesChanged }: { onFilesChanged: () => void }): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DependencyProject[]>([])
  const [managed, setManaged] = useState<ManagedDependency[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [mavenCoordinate, setMavenCoordinate] = useState('')
  const [mavenRepository, setMavenRepository] = useState('')
  const [mavenConfiguration, setMavenConfiguration] = useState<'implementation' | 'modImplementation' | 'compileOnly' | 'runtimeOnly'>('implementation')

  const refresh = async (): Promise<void> => setManaged(await window.modmind.production.dependencies.list())

  useEffect(() => {
    void refresh().catch((error) => setNotice(errorMessage(error)))
  }, [])

  const search = async (): Promise<void> => {
    if (!query.trim() || busy) return
    setBusy('search')
    setNotice('')
    try {
      const result = await window.modmind.production.dependencies.search(query)
      setHits(result.hits)
      if (!result.hits.length) setNotice('没有找到与当前 Loader 和 Minecraft 版本兼容的项目')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const install = async (dependencyProject: DependencyProject): Promise<void> => {
    setBusy(dependencyProject.projectId)
    setNotice('')
    try {
      const installed = await window.modmind.production.dependencies.install({ projectId: dependencyProject.projectId })
      await refresh()
      onFilesChanged()
      setNotice(`已安装 ${installed.name} ${installed.versionNumber}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const remove = async (dependency: ManagedDependency): Promise<void> => {
    if (!await requestConfirm({ title: `移除依赖“${dependency.name}”？`, message: '将同步更新 Gradle、项目依赖目录和测试实例', confirmLabel: '移除依赖', tone: 'danger' })) return
    setBusy(dependency.projectId)
    setNotice('')
    try {
      setManaged(await window.modmind.production.dependencies.remove(dependency.projectId))
      onFilesChanged()
      setNotice(`已移除 ${dependency.name}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const installMaven = async (): Promise<void> => {
    if (!mavenCoordinate.trim() || busy) return
    setBusy('maven')
    setNotice('')
    try {
      const installed = await window.modmind.production.dependencies.installMaven({
        coordinate: mavenCoordinate,
        repository: mavenRepository,
        configuration: mavenConfiguration
      })
      await refresh()
      onFilesChanged()
      setNotice(`已添加 Maven 依赖 ${installed.coordinate}`)
      setMavenCoordinate('')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const auditDependencies = async (): Promise<void> => {
    setBusy('audit')
    setNotice('')
    try {
      const audit = await window.modmind.production.dependencies.audit()
      const details = [...audit.errors, ...audit.warnings]
      setNotice(`${audit.success ? '依赖锁定检查通过' : '依赖锁定检查失败'}：${audit.checked} 项${details.length ? `；${details.join('；')}` : ''}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const installedIds = useMemo(() => new Set(managed.map((entry) => entry.projectId)), [managed])

  return <div className="production-pane dependency-pane">
    <div className="production-toolbar">
      <div><h2>Modrinth 依赖中心</h2><p>搜索结果已按当前 Loader 与 Minecraft 版本筛选</p></div>
      <div className="production-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="搜索 API、前置或兼容模组" />
        <button className="primary-button" disabled={!query.trim() || Boolean(busy)} onClick={() => void search()}>{busy === 'search' ? <LoaderCircle className="spin" size={15} /> : <PackageSearch size={15} />}搜索</button>
      </div>
    </div>
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    <section className="maven-dependency-form">
      <div className="maven-dependency-copy"><h3>Maven 坐标</h3><p>添加不在 Modrinth 上的 API 或库；仓库地址仅允许 HTTPS</p></div>
      <label className="maven-field">坐标<input value={mavenCoordinate} onChange={(event) => setMavenCoordinate(event.target.value)} placeholder="group:artifact:version" /></label>
      <label className="maven-field">仓库地址<input value={mavenRepository} onChange={(event) => setMavenRepository(event.target.value)} placeholder="https://repo.example.com/releases（可选）" /></label>
      <label className="maven-field">依赖配置<select value={mavenConfiguration} onChange={(event) => setMavenConfiguration(event.target.value as typeof mavenConfiguration)}>
        <option value="implementation">implementation</option>
        <option value="modImplementation">modImplementation</option>
        <option value="compileOnly">compileOnly</option>
        <option value="runtimeOnly">runtimeOnly</option>
      </select></label>
      <button className="secondary-button" disabled={!mavenCoordinate.trim() || Boolean(busy)} onClick={() => void installMaven()}>{busy === 'maven' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}添加 Maven</button>
    </section>
    <section className="managed-dependencies">
      <div className="section-title-row"><h2>项目依赖</h2><span>{managed.length} 项</span><button className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void auditDependencies()}>{busy === 'audit' ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}审计锁文件</button></div>
      {managed.length ? managed.map((dependency) => <div className="managed-dependency-row" key={dependency.projectId}>
        <span className="dependency-mark"><Check size={14} /></span>
        <div><strong>{dependency.name}</strong><small>{dependency.versionNumber} · {dependency.source === 'maven' ? dependency.configuration : dependency.environment === 'both' ? '客户端与服务端' : dependency.environment === 'client' ? '仅客户端' : '仅服务端'}</small></div>
        <code>{dependency.source === 'maven' ? dependency.coordinate : dependency.fileName}</code>
        <button className="icon-button" title="移除依赖" disabled={Boolean(busy)} onClick={() => void remove(dependency)}>{busy === dependency.projectId ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button>
      </div>) : <div className="inline-empty">尚未添加受管依赖</div>}
    </section>
    <section className="dependency-results" aria-label="依赖搜索结果">
      {hits.map((dependencyProject) => <article className="dependency-result" key={dependencyProject.projectId}>
        <DependencyIcon url={dependencyProject.iconUrl} />
        <div><h3>{dependencyProject.title}</h3><p>{dependencyProject.description}</p><small>{compactNumber(dependencyProject.downloads)} 次下载 · 客户端 {dependencyProject.clientSide} / 服务端 {dependencyProject.serverSide}</small></div>
        <button className={installedIds.has(dependencyProject.projectId) ? 'secondary-button compact' : 'primary-button compact'} disabled={Boolean(busy)} onClick={() => void install(dependencyProject)}>{busy === dependencyProject.projectId ? <LoaderCircle className="spin" size={14} /> : installedIds.has(dependencyProject.projectId) ? <RefreshCw size={14} /> : <Download size={14} />}{installedIds.has(dependencyProject.projectId) ? '更新' : '安装'}</button>
      </article>)}
    </section>
    {confirmDialog}
  </div>
}

function ContentPane({ onFilesChanged }: { onFilesChanged: () => void }): React.JSX.Element {
  const [kind, setKind] = useState<ContentKind>('language')
  const [id, setId] = useState('')
  const [locale, setLocale] = useState('zh_cn')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [resultId, setResultId] = useState('')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [validation, setValidation] = useState<{ success: boolean; errors: string[]; warnings: string[]; checkedFiles: number } | null>(null)

  const create = async (): Promise<void> => {
    if (!id.trim() || busy) return
    setBusy('create')
    setNotice('')
    try {
      let data: Record<string, unknown>
      if (kind === 'data-json' || kind === 'asset-json') data = { value: JSON.parse(primary) as unknown }
      else if (kind === 'language') data = { key: primary, value: secondary }
      else if (kind === 'recipe-shapeless') data = { ingredients: primary.split(',').map((item) => item.trim()).filter(Boolean), result: resultId, count }
      else if (kind === 'recipe-shaped') {
        const keyEntries = secondary.split(',').map((entry) => entry.split('=', 2).map((item) => item.trim())).filter((entry) => entry.length === 2 && entry[0] && entry[1])
        data = { pattern: primary.split(','), key: Object.fromEntries(keyEntries), result: resultId, count }
      } else if (kind === 'item-tag' || kind === 'block-tag') data = { values: primary.split(',').map((item) => item.trim()).filter(Boolean), replace: false }
      else if (kind === 'loot-block') data = { item: primary }
      else data = { icon: primary, criterionItem: secondary || primary, frame: 'task' }
      const result = await window.modmind.production.content.create({ kind, id, locale, data })
      setNotice(result.summary)
      onFilesChanged()
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const importAudio = async (): Promise<void> => {
    if (!id.trim() || busy) return
    setBusy('audio')
    setNotice('')
    try {
      const result = await window.modmind.production.content.importAudio({ eventId: id, stream: true })
      if (result) {
        setNotice(result.summary)
        onFilesChanged()
      }
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const validate = async (): Promise<void> => {
    setBusy('validate')
    setNotice('')
    try {
      setValidation(await window.modmind.production.content.validate())
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const labels: Record<ContentKind, [string, string]> = {
    language: ['翻译键', '显示文本'],
    'recipe-shaped': ['图案行（逗号分隔）', '键值（A=minecraft:stone）'],
    'recipe-shapeless': ['材料 ID（逗号分隔）', ''],
    'item-tag': ['物品 ID（逗号分隔）', ''],
    'block-tag': ['方块 ID（逗号分隔）', ''],
    'loot-block': ['掉落物 ID', ''],
    advancement: ['图标物品 ID', '条件物品 ID'],
    'data-json': ['JSON 内容', ''],
    'asset-json': ['JSON 内容', '']
  }
  const recipe = kind === 'recipe-shaped' || kind === 'recipe-shapeless'
  const rawJson = kind === 'data-json' || kind === 'asset-json'

  return <div className="production-pane content-pane">
    <div className="production-toolbar">
      <div><h2>内容与数据</h2><p>生成版本匹配的资源 JSON，导入音频并检查资源引用</p></div>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void validate()}>{busy === 'validate' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}验证资源</button>
    </div>
    <div className="content-builder">
      <div className="content-kind-list" role="tablist" aria-label="内容类型">{contentKinds.map((item) => <button role="tab" aria-selected={kind === item.id} className={kind === item.id ? 'active' : ''} key={item.id} onClick={() => setKind(item.id)}>{item.label}</button>)}</div>
      <div className="content-form">
        <label>{rawJson ? '相对路径' : '资源 ID'}<input value={id} onChange={(event) => setId(event.target.value)} placeholder={rawJson ? 'worldgen/biome/example' : 'example/path'} /></label>
        {kind === 'language' ? <label>语言<select value={locale} onChange={(event) => setLocale(event.target.value)}><option value="zh_cn">简体中文</option><option value="en_us">English</option></select></label> : null}
        <label>{labels[kind][0]}{rawJson
          ? <textarea className="content-json-input" value={primary} onChange={(event) => setPrimary(event.target.value)} spellCheck={false} placeholder={'{\n  "type": "minecraft:example"\n}'} />
          : <input value={primary} onChange={(event) => setPrimary(event.target.value)} />}</label>
        {labels[kind][1] ? <label>{labels[kind][1]}<input value={secondary} onChange={(event) => setSecondary(event.target.value)} /></label> : null}
        {recipe ? <label>产物 ID<input value={resultId} onChange={(event) => setResultId(event.target.value)} placeholder="minecraft:stone" /></label> : null}
        {recipe ? <label>数量<input type="number" min={1} max={64} value={count} onChange={(event) => setCount(Math.min(64, Math.max(1, Number(event.target.value))))} /></label> : null}
        <div className="content-actions">
          <button className="primary-button" disabled={!id.trim() || (recipe && !resultId.trim()) || (rawJson && !primary.trim()) || Boolean(busy)} onClick={() => void create()}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}生成文件</button>
          <button className="secondary-button" disabled={!id.trim() || Boolean(busy)} onClick={() => void importAudio()}>{busy === 'audio' ? <LoaderCircle className="spin" size={15} /> : <Music size={15} />}导入声音</button>
        </div>
      </div>
    </div>
    {notice ? <div className="production-notice"><FileJson size={14} /><span>{notice}</span></div> : null}
    {validation ? <div className={`validation-summary ${validation.success ? 'success' : 'error'}`}>
      <strong>{validation.success ? <Check size={15} /> : <X size={15} />}{validation.success ? '资源验证通过' : '资源验证失败'}</strong>
      <span>{validation.checkedFiles} 个文件 · {validation.errors.length} 个错误 · {validation.warnings.length} 个警告</span>
      {[...validation.errors, ...validation.warnings].slice(0, 12).map((item) => <p key={item}>{item}</p>)}
    </div> : null}
  </div>
}

function TestsPane(): React.JSX.Element {
  const [targets, setTargets] = useState<TestTarget[]>(['build', 'client', 'server', 'gametest'])
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<TestMatrixResult | null>(null)
  const [notice, setNotice] = useState('')

  const toggle = (target: TestTarget): void => setTargets((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])

  const run = async (): Promise<void> => {
    if (!targets.length || busy) return
    setBusy('matrix')
    setResult(null)
    setNotice('')
    try {
      setResult(await window.modmind.production.tests.runMatrix(targets))
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const workflow = async (): Promise<void> => {
    setBusy('workflow')
    setNotice('')
    try {
      setNotice(`已生成 ${await window.modmind.production.tests.generateWorkflow()}`)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }


  return <div className="production-pane tests-pane">
    <div className="production-toolbar">
      <div><h2>自动测试矩阵</h2><p>顺序验证构建、客户端、专用服务器和 Loader GameTest</p></div>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void workflow()}>{busy === 'workflow' ? <LoaderCircle className="spin" size={15} /> : <Workflow size={15} />}生成 CI</button>
    </div>
    <div className="test-targets">{testTargets.map((target) => <label key={target.id} className={targets.includes(target.id) ? 'selected' : ''}>
      <input type="checkbox" checked={targets.includes(target.id)} onChange={() => toggle(target.id)} />
      <span><strong>{target.label}</strong><small>{target.detail}</small></span>
    </label>)}</div>
    <button className="primary-button matrix-run" disabled={!targets.length || Boolean(busy)} onClick={() => void run()}>{busy === 'matrix' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}运行选中测试</button>
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    {result ? <div className="matrix-results">{result.results.map((entry) => <div className={`matrix-result ${entry.status}`} key={entry.target}>
      <span>{entry.status === 'passed' ? <Check size={15} /> : entry.status === 'failed' ? <X size={15} /> : <CircleAlert size={15} />}</span>
      <div><strong>{testTargets.find((item) => item.id === entry.target)?.label ?? entry.target}</strong><p>{entry.summary}</p></div>
      <time>{(entry.durationMs / 1000).toFixed(1)}s</time>
    </div>)}</div> : null}
  </div>
}

function ReleasePane({ project }: { project: ProjectInfo }): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const [settings, setSettings] = useState<ReleaseSettings>(() => defaultRelease(project))
  const [targets, setTargets] = useState<PublishTarget[]>([])
  const [preflight, setPreflight] = useState<ReleasePreflightResult | null>(null)
  const [results, setResults] = useState<ReleasePublishResult[]>([])
  const [busy, setBusy] = useState('load')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.modmind.production.release.getSettings().then(setSettings).catch((error) => setNotice(errorMessage(error))).finally(() => setBusy(''))
  }, [project.path])

  const update = <K extends keyof ReleaseSettings>(key: K, value: ReleaseSettings[K]): void => {
    setSettings((current) => ({ ...current, [key]: value }))
    setPreflight(null)
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setNotice('')
    try {
      setSettings(await window.modmind.production.release.saveSettings(settings))
      setNotice('发布配置已保存，令牌使用系统加密存储')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const check = async (): Promise<void> => {
    setBusy('check')
    setNotice('')
    try {
      setPreflight(await window.modmind.production.release.preflight())
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const publish = async (): Promise<void> => {
    if (!preflight?.ready) {
      setNotice('请先完成预检并修复失败项')
      return
    }
    if (!targets.length || !await requestConfirm({ title: `确认发布 ${settings.version}？`, message: `目标：${targets.join('、')}\n\n这是不可自动撤销的外部操作`, confirmLabel: '确认发布', tone: 'danger', actionIcon: 'continue' })) return
    setBusy('publish')
    setResults([])
    setNotice('')
    try {
      setResults(await window.modmind.production.release.publish({ targets, confirmed: true }))
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const toggle = (target: PublishTarget): void => setTargets((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])

  return <div className="production-pane release-pane">
    <div className="production-toolbar">
      <div><h2>发布中心</h2><p>统一预检并发布到 Modrinth、CurseForge 和 GitHub Releases</p></div>
      <div className="production-toolbar-actions">
        <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void check()}>{busy === 'check' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}预检</button>
        <button className="primary-button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存</button>
      </div>
    </div>
    <div className="release-form">
      <label>版本<input value={settings.version} onChange={(event) => update('version', event.target.value)} /></label>
      <label>显示名称<input value={settings.displayName} onChange={(event) => update('displayName', event.target.value)} /></label>
      <label>摘要<textarea value={settings.summary ?? ''} onChange={(event) => update('summary', event.target.value)} /></label>
      <label>自动递增<select value={settings.bumpMode ?? 'patch'} onChange={(event) => update('bumpMode', event.target.value as NonNullable<ReleaseSettings['bumpMode']>)}><option value="patch">Patch</option><option value="minor">Minor</option><option value="major">Major</option></select></label>
      <label className="check-row"><input type="checkbox" checked={settings.autoBump !== false} onChange={(event) => update('autoBump', event.target.checked)} />导出成功后自动增加版本</label>
      <label>通道<select value={settings.channel} onChange={(event) => update('channel', event.target.value as ReleaseSettings['channel'])}><option value="release">Release</option><option value="beta">Beta</option><option value="alpha">Alpha</option></select></label>
      <label className="release-platform-id">Modrinth 项目 ID<input value={settings.modrinthProjectId} onChange={(event) => update('modrinthProjectId', event.target.value)} /></label>
      <label className="release-platform-token">Modrinth Token<SecretInput secretKey="modrinthToken" stored={Boolean(settings.hasModrinthToken)} value={settings.modrinthToken ?? ''} onChange={(event) => update('modrinthToken', event.target.value)} placeholder={settings.hasModrinthToken ? '已加密保存，留空保持不变' : ''} /></label>
      <label className="release-platform-id">CurseForge 项目 ID<input value={settings.curseForgeProjectId} onChange={(event) => update('curseForgeProjectId', event.target.value)} /></label>
      <label className="release-platform-token">CurseForge Token<SecretInput secretKey="curseForgeToken" stored={Boolean(settings.hasCurseForgeToken)} value={settings.curseForgeToken ?? ''} onChange={(event) => update('curseForgeToken', event.target.value)} placeholder={settings.hasCurseForgeToken ? '已加密保存，留空保持不变' : ''} /></label>
      <label className="release-platform-id">GitHub 仓库<input value={settings.githubRepository} onChange={(event) => update('githubRepository', event.target.value)} placeholder="owner/repository" /></label>
      <label className="release-platform-token">GitHub Token<SecretInput secretKey="githubToken" stored={Boolean(settings.hasGithubToken)} value={settings.githubToken ?? ''} onChange={(event) => update('githubToken', event.target.value)} placeholder={settings.hasGithubToken ? '已加密保存，留空保持不变' : ''} /></label>
      <label className="release-changelog">更新日志<textarea value={settings.changelog} onChange={(event) => update('changelog', event.target.value)} /></label>
    </div>
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    {preflight ? <div className="release-checks">{preflight.checks.map((checkItem) => <div className={checkItem.status} key={checkItem.id}>
      <span>{checkItem.status === 'pass' ? <Check size={14} /> : <CircleAlert size={14} />}</span><strong>{checkItem.label}</strong><p>{checkItem.detail}</p>
    </div>)}</div> : null}
    <div className="publish-row">
      <div>{(['modrinth', 'curseforge', 'github'] as const).map((target) => <label key={target}><input type="checkbox" checked={targets.includes(target)} onChange={() => toggle(target)} />{target === 'modrinth' ? 'Modrinth' : target === 'curseforge' ? 'CurseForge' : 'GitHub'}</label>)}</div>
      <button className="primary-button" disabled={!targets.length || Boolean(busy) || !preflight?.ready} onClick={() => void publish()}>{busy === 'publish' ? <LoaderCircle className="spin" size={15} /> : <CloudUpload size={15} />}确认发布</button>
    </div>
    {results.length ? <div className="publish-results">{results.map((result) => <div className={result.success ? 'success' : 'error'} key={result.target}>{result.success ? <Check size={14} /> : <X size={14} />}<strong>{result.target}</strong><span>{result.detail}</span></div>)}</div> : null}
    {confirmDialog}
  </div>
}

function ModpackDeliveryPane({ project }: { project: ProjectInfo }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [settings, setSettings] = useState<ReleaseSettings>(() => defaultRelease(project))

  useEffect(() => {
    void window.modmind.production.release.getSettings().then(setSettings).catch((error) => setNotice(errorMessage(error)))
  }, [project.path])

  const update = <K extends keyof ReleaseSettings>(key: K, value: ReleaseSettings[K]): void => setSettings((current) => ({ ...current, [key]: value }))

  const suggestSummary = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      const draft = await window.modmind.production.release.suggestSummary()
      setSettings((current) => ({ ...current, summary: draft.summary, changelog: draft.changelog || current.changelog }))
      setNotice(draft.generatedBy === 'ai' ? 'AI 已生成可编辑的摘要和更新日志草稿' : '已根据本地整合包内容生成摘要草稿；连接 AI 后可获得更精炼的文案')
    } catch (error) {
      setNotice(`生成摘要失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const exportPack = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      await window.modmind.production.release.saveSettings(settings)
      const target = await window.modmind.project.exportArtifact()
      if (target) {
        setSettings(await window.modmind.production.release.getSettings())
        setNotice(`整合包已导出到 ${target}`)
      }
    } catch (error) {
      setNotice(`导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const exportServerPack = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      const target = await window.modmind.modpack.exportServerPack()
      if (target) setNotice(`服务端包已导出：${target}`)
    } catch (error) {
      setNotice(`服务端包导出失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return <div className="production-page">
    <header className="content-toolbar">
      <div><h1>交付</h1><p>{project.loader} · Minecraft {project.minecraftVersion} · Modrinth 整合包</p></div>
      <span className="production-ready"><GitBranch size={14} />整合包归档</span>
    </header>
    <section className="production-pane modpack-delivery-pane">
      <div><h2>版本与导出</h2><p>当前版本用于本次 .mrpack；成功导出后才更新到下一版本</p></div>
      <div className="release-form modpack-release-form">
        <label>版本<input value={settings.version} onChange={(event) => update('version', event.target.value)} /></label>
        <label>显示名称<input value={settings.displayName} onChange={(event) => update('displayName', event.target.value)} /></label>
        <label>自动递增<select value={settings.bumpMode ?? 'patch'} onChange={(event) => update('bumpMode', event.target.value as NonNullable<ReleaseSettings['bumpMode']>)}><option value="patch">Patch</option><option value="minor">Minor</option><option value="major">Major</option></select></label>
        <label className="check-row"><input type="checkbox" checked={settings.autoBump !== false} onChange={(event) => update('autoBump', event.target.checked)} />导出成功后自动递增</label>
        <label className="release-changelog">摘要<textarea value={settings.summary ?? ''} onChange={(event) => update('summary', event.target.value)} placeholder="用于 Modrinth 整合包摘要" /></label>
        <label className="release-changelog">更新日志<textarea value={settings.changelog} onChange={(event) => update('changelog', event.target.value)} placeholder="说明这次交付的变化" /></label>
      </div>
      <div className="modpack-delivery-actions"><button className="secondary-button" disabled={busy} onClick={() => void suggestSummary()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}AI 草拟摘要</button><button className="secondary-button" disabled={busy} onClick={() => void exportServerPack()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导出服务端包</button><button className="primary-button" disabled={busy} onClick={() => void exportPack()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导出 .mrpack</button></div>
      {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    </section>
  </div>
}

export default function ProductionWorkspace({ project, onFilesChanged }: { project: ProjectInfo; onFilesChanged: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<ProductionTab>('dependencies')

  if (project.kind === 'modpack') return <ModpackDeliveryPane project={project} />

  return <div className="production-page">
    <header className="content-toolbar">
      <div><h1>生产中心</h1><p>{project.loader} · Minecraft {project.minecraftVersion}</p></div>
      <span className="production-ready"><GitBranch size={14} />交付工具链</span>
    </header>
    <nav className="production-tabs" aria-label="生产中心">
      {([['dependencies', '依赖'], ['content', '内容'], ['tests', '测试矩阵'], ['release', '发布']] as Array<[ProductionTab, string]>).map(([id, label]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {tab === 'dependencies' ? <DependenciesPane onFilesChanged={onFilesChanged} /> : null}
    {tab === 'content' ? <ContentPane onFilesChanged={onFilesChanged} /> : null}
    {tab === 'tests' ? <TestsPane /> : null}
    {tab === 'release' ? <ReleasePane project={project} /> : null}
  </div>
}
