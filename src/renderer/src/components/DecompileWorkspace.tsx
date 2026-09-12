import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Binary,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileSearch,
  Loader2,
  Lock,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  X
} from 'lucide-react'
import type { DecompileFileEntry, DecompileInspectResult, DecompileProgressEvent, DecompileReferenceReport, DecompileRunResult } from '../../../shared/decompile'
import type { JavaLoaderKind, ProjectInfo } from '../../../shared/types'
import MonacoCodeEditor from './MonacoCodeEditor'

interface HistoryItem {
  jarPath: string
  sha256: string
  fileName: string
  displayName: string
  cachedAt: string
}

const HISTORY_KEY = 'modmind-decompile-history:v1'

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(parsed) ? parsed.filter((entry): entry is HistoryItem => Boolean(entry && typeof entry === 'object' && typeof (entry as HistoryItem).jarPath === 'string')) : []
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20))) } catch { /* storage full: history is best-effort */ }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  file?: DecompileFileEntry
}

function buildFileTree(files: DecompileFileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() }
  for (const file of files) {
    const parts = file.relativePath.split('/')
    let current: TreeNode = root
    parts.forEach((part: string, index: number) => {
      const isLeaf = index === parts.length - 1
      const nodePath = parts.slice(0, index + 1).join('/')
      let next = current.children.get(part)
      if (!next) {
        next = { name: part, path: nodePath, children: new Map() }
        current.children.set(part, next)
      }
      if (isLeaf) next.file = file
      current = next
    })
  }
  return root
}

function TreeView({ node, depth, selectedPath, onSelect }: { node: TreeNode; depth: number; selectedPath: string | null; onSelect: (file: DecompileFileEntry) => void }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(depth < 3)
  const sortedChildren = useMemo(() => [...node.children.values()].sort((left, right) => {
    const leftDir = left.children.size > 0 ? 0 : 1
    const rightDir = right.children.size > 0 ? 0 : 1
    return leftDir - rightDir || left.name.localeCompare(right.name)
  }), [node])
  if (!node.file && !node.children.size) return null
  const isDirectory = node.children.size > 0 && !node.file
  const selected = node.file?.relativePath === selectedPath
  return <>
    <button
      type="button"
      className={`decompile-tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => {
        if (isDirectory) setExpanded((value) => !value)
        else if (node.file) onSelect(node.file)
      }}
    >
      {isDirectory ? <ChevronRight size={13} className={expanded ? 'rotated' : ''} /> : <FileCode2 size={13} />}
      <span className="decompile-tree-name">{node.name}</span>
      {node.file?.hasErrors ? <span className="decompile-error-icon" title="该类包含未能完全还原的方法"><AlertTriangle size={12} /></span> : null}
    </button>
    {expanded ? sortedChildren.map((child) => <TreeView key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />) : null}
  </>
}

interface DecompileWorkspaceProps {
  initialJarPath?: string | null
  projectContext?: { kind?: string } | null
  darkMode: boolean
  onProjectCreated?: (project: ProjectInfo) => void
}

export default function DecompileWorkspace({ initialJarPath, projectContext, darkMode, onProjectCreated }: DecompileWorkspaceProps): React.JSX.Element {
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory())
  const [inspect, setInspect] = useState<DecompileInspectResult | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [inspectionStatus, setInspectionStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<DecompileProgressEvent | null>(null)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<DecompileFileEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<DecompileFileEntry | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [loadingFile, setLoadingFile] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [fullTextQuery, setFullTextQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ relativePath: string; line: number; text: string }> | null>(null)
  const [referenceReport, setReferenceReport] = useState<(DecompileReferenceReport & { scannedClasses: number }) | null>(null)
  const [mcVersionInput, setMcVersionInput] = useState('')
  const [projectLoader, setProjectLoader] = useState<JavaLoaderKind>('fabric')
  const [projectMinecraftVersion, setProjectMinecraftVersion] = useState('')
  const [skipRemap, setSkipRemap] = useState(false)
  const inspectedRef = useRef<DecompileInspectResult | null>(null)
  const initialInspectPathRef = useRef<string | null>(null)
  const takeoverFlow = !projectContext

  const rememberHistory = useCallback((entry: HistoryItem) => {
    setHistory((current) => {
      const deduped = [entry, ...current.filter((item) => item.sha256 !== entry.sha256)]
      saveHistory(deduped)
      return deduped.slice(0, 20)
    })
  }, [])

  useEffect(() => window.modmind.decompile.onProgress((event) => {
    setProgress(event)
    if (event.phase === 'done' || event.phase === 'error' || event.phase === 'cancelled') setRunning(false)
  }), [])

  const openCachedFiles = useCallback(async (sha256: string): Promise<void> => {
    const list = await window.modmind.decompile.listFiles(sha256)
    setFiles(list)
    const first = list.find((file) => !file.hasErrors) ?? list[0]
    if (first) await selectAndLoad(sha256, first)
  }, [])

  async function selectAndLoad(sha256: string, file: DecompileFileEntry): Promise<void> {
    setSelectedFile(file)
    setLoadingFile(true)
    try {
      setFileContent(await window.modmind.decompile.readFile(sha256, file.relativePath))
    } catch (reason) {
      setFileContent(`// 无法读取文件：${errorMessage(reason)}`)
    } finally {
      setLoadingFile(false)
    }
  }

  const runPipeline = useCallback(async (jarPath: string, options?: { skipRemap?: boolean; minecraftVersion?: string }): Promise<DecompileRunResult | null> => {
    setError('')
    setRunning(true)
    setProgress({ jarSha256: '', phase: 'hashing', message: '正在准备…' })
    try {
      const result = await window.modmind.decompile.start({ jarPath, ...options })
      rememberHistory({
        jarPath,
        sha256: result.sha256,
        fileName: result.provenance.sourceFileName,
        displayName: result.provenance.sourceFileName.replace(/\.jar$/i, ''),
        cachedAt: result.provenance.createdAt
      })
      await openCachedFiles(result.sha256)
      return result
    } catch (reason) {
      setError(errorMessage(reason))
      return null
    } finally {
      setRunning(false)
    }
  }, [openCachedFiles, rememberHistory])

  const inspectJar = useCallback(async (jarPath: string): Promise<void> => {
    inspectedRef.current = null
    setInspect(null)
    setError('')
    setInspecting(true)
    setInspectionStatus('正在识别 JAR、读取模组描述和 Minecraft 版本…')
    setFiles([])
    setSelectedFile(null)
    setFileContent('')
    setReferenceReport(null)
    setSearchResults(null)
    try {
      const result = await window.modmind.decompile.inspect(jarPath)
      inspectedRef.current = result
      setInspect(result)
      setMcVersionInput(result.minecraftVersions[0] ?? '')
      setSkipRemap(false)
      setProjectMinecraftVersion(result.minecraftVersions[0] ?? '')
      setProjectLoader(result.loader ?? 'fabric')
      setModuleNameInput((result.displayName ?? result.fileName.replace(/\.jar$/i, '')).replace(/[^a-zA-Z0-9_ ]/g, '').slice(0, 40) || 'decompiled-mod')
      if (result.cached || !result.hasClasses) {
        // Either reuse the cache immediately or fail fast with a clear error.
        if (result.cached) await runPipeline(jarPath, { skipRemap: true })
        else if (!result.hasClasses) setError('该 JAR 中没有 Java 字节码（.class 文件），无法反编译')
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setInspecting(false)
      setInspectionStatus('')
    }
  }, [runPipeline])

  const pickJar = useCallback(async (): Promise<void> => {
    const picked = await window.modmind.decompile.pickJar()
    if (picked) await inspectJar(picked)
  }, [inspectJar])

  useEffect(() => {
    if (initialJarPath && initialInspectPathRef.current !== initialJarPath) {
      initialInspectPathRef.current = initialJarPath
      void inspectJar(initialJarPath)
    }
    // Only react to the initial handoff; later changes come from user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJarPath])

  // ---- Export as self-made module (转为自制模组) with mandatory terms consent ----
  const [termsDialogOpen, setTermsDialogOpen] = useState(false)
  const [termsTarget, setTermsTarget] = useState<'module' | 'project'>('module')
  const [terms, setTerms] = useState<import('../../../shared/decompileModuleExport').DecompileTermsPayload | null>(null)
  const [moduleNameInput, setModuleNameInput] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')

  const openTermsDialog = useCallback(async (target: 'module' | 'project' = 'module'): Promise<void> => {
    const sourceFileName = inspectedRef.current?.fileName ?? 'mod.jar'
    setTermsTarget(target)
    setModuleNameInput((inspectedRef.current?.displayName ?? 'decompiled-mod').replace(/[^a-zA-Z0-9_ ]/g, '').slice(0, 40) || 'decompiled-mod')
    setProjectLoader(inspectedRef.current?.loader ?? 'fabric')
    setProjectMinecraftVersion(mcVersionInput.trim() || inspectedRef.current?.minecraftVersions[0] || '')
    setExportNotice('')
    setTerms(await window.modmind.decompile.getTerms(sourceFileName))
    setTermsDialogOpen(true)
  }, [mcVersionInput])

  const confirmExportModule = useCallback(async (): Promise<void> => {
    const sha = inspectedRef.current?.sha256
    if (!sha || !terms) return
    setExportBusy(true)
    setExportNotice('')
    try {
      const created = await window.modmind.decompile.createModuleFromJar({
        sourceSha256: sha,
        moduleName: moduleNameInput,
        termsAcknowledgement: { termsVersion: terms.version, acknowledged: true, origin: 'user-workspace' }
      })
      setTermsDialogOpen(false)
      setExportNotice(`已创建自制模组模块 ${created.namespace}（${created.fileCount} 个文件）。它已加入整合包的 modules/ 目录，条款与来源记录随模块保存。`)
    } catch (reason) {
      setExportNotice(errorMessage(reason))
    } finally {
      setExportBusy(false)
    }
  }, [moduleNameInput, terms])

  const confirmCreateProject = useCallback(async (): Promise<void> => {
    const sha = inspectedRef.current?.sha256
    if (!sha || !terms || !projectMinecraftVersion.trim() || !moduleNameInput.trim()) return
    setExportBusy(true)
    setExportNotice('')
    try {
      const created = await window.modmind.decompile.createProjectFromJar({
        sourceSha256: sha,
        name: moduleNameInput,
        loader: projectLoader,
        minecraftVersion: projectMinecraftVersion.trim(),
        termsAcknowledgement: { termsVersion: terms.version, acknowledged: true, origin: 'user-workspace' }
      })
      if (!created) {
        setExportBusy(false)
        return
      }
      setTermsDialogOpen(false)
      setExportNotice(`已成功创建 ModMind 项目 ${created.name}，反编译源码与条款记录已写入项目。`)
      onProjectCreated?.(created)
    } catch (reason) {
      setExportNotice(errorMessage(reason))
    } finally {
      setExportBusy(false)
    }
  }, [moduleNameInput, onProjectCreated, projectLoader, projectMinecraftVersion, terms])

  const startAndConvertProject = useCallback(async (): Promise<void> => {
    if (!inspect) return
    const minecraftVersion = mcVersionInput.trim() || inspect.minecraftVersions[0] || ''
    if (!minecraftVersion) {
      setError('请先填写 Minecraft 版本，或使用自动识别的版本。')
      return
    }
    const result = await runPipeline(inspect.filePath, {
      skipRemap,
      ...(minecraftVersion ? { minecraftVersion } : {})
    })
    if (result) await openTermsDialog('project')
  }, [inspect, mcVersionInput, openTermsDialog, runPipeline, skipRemap])

  const runSearch = useCallback(async (): Promise<void> => {
    const sha = inspectedRef.current?.sha256
    if (!fullTextQuery.trim() || !sha || files.length >= 8000) {
      setSearchResults(null)
      return
    }
    const query = fullTextQuery.toLowerCase()
    const results: Array<{ relativePath: string; line: number; text: string }> = []
    for (const file of files) {
      const content = await window.modmind.decompile.readFile(sha, file.relativePath).catch(() => '')
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(query)) {
          results.push({ relativePath: file.relativePath, line: index + 1, text: lines[index].trim().slice(0, 160) })
          if (results.length >= 300) break
        }
      }
      if (results.length >= 300) break
    }
    setSearchResults(results)
  }, [files, fullTextQuery])

  const scanReferences = useCallback(async (): Promise<void> => {
    const jarPath = inspectedRef.current?.filePath
    if (!jarPath) return
    setError('')
    try {
      setReferenceReport(await window.modmind.decompile.scanReferences(jarPath))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [])

  const filteredTree = useMemo(() => buildFileTree(
    searchQuery.trim()
      ? files.filter((file) => file.relativePath.toLowerCase().includes(searchQuery.toLowerCase()))
      : files
  ), [files, searchQuery])

  const obfuscationBanner = inspect?.obfuscationHint === 'obfuscated'
    ? <div className="decompile-banner warning"><AlertTriangle size={15} /><span>此模组经过混淆（约 {Math.round((inspect.obfuscationRatio ?? 0) * 100)}% 的类名不可读），反编译结果可读性有限。</span></div>
    : null

  return (
    <div className="decompile-workspace">
      <aside className="decompile-sidebar">
        <div className="decompile-sidebar-header">
          <Binary size={17} />
          <strong>受控反编译</strong>
        </div>
        <button className="primary-button decompile-pick" type="button" onClick={() => void pickJar()} disabled={running || inspecting}>
          {inspecting ? <Loader2 className="spin" size={16} /> : <FileSearch size={16} />}
          选择 JAR 文件
        </button>
        {history.length ? (
          <div className="decompile-history">
            <h4>最近分析</h4>
            {history.map((item) => (
              <button key={item.sha256} type="button" className="decompile-history-item" onClick={() => void inspectJar(item.jarPath)} disabled={running || inspecting}>
                <FileCode2 size={14} />
                <span>{item.displayName}</span>
              </button>
            ))}
          </div>
        ) : null}
        {referenceReport ? (
          <div className="decompile-references">
            <h4><ShieldCheck size={14} /> 字节码引用（{referenceReport.scannedClasses} 个类）</h4>
            {referenceReport.items.slice(0, 24).map((item) => (
              <div key={item.packageName} className="decompile-reference-row" title={item.sampleClasses.join('\n')}>
                <code>{item.packageName}</code>
                <small>{item.matchedModIds.length ? `→ ${item.matchedModIds.join(', ')}` : `${item.referenceCount} 处引用`}</small>
              </div>
            ))}
            {!referenceReport.items.length ? <p className="muted">未发现第三方包引用</p> : null}
          </div>
        ) : null}
      </aside>

      <section className="decompile-main">
        {error ? (
          <div className="decompile-banner error">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button type="button" className="icon-button" onClick={() => setError('')}><X size={14} /></button>
          </div>
        ) : null}
        {inspecting && !running ? (
          <div className="decompile-progress decompile-inspection-status" role="status" aria-live="polite">
            <Loader2 className="spin" size={15} />
            <span>{inspectionStatus || '正在识别 JAR，请稍候…'}</span>
          </div>
        ) : null}
        {!inspect && !running && !error ? (
          <div className="decompile-empty">
            <Lock size={28} />
            <h3>受控反编译工作区</h3>
            <p>选择一个 Mod JAR，在应用内只读浏览其源码、验证前置依赖的真实 API 用法，或为版本迁移收集证据。</p>
            <p className="muted">反编译结果保存在应用缓存中并标注来源与哈希；它们不是项目源码，也不会进入任何导出产物。</p>
            <p className="muted">注意：原始注释与局部变量名在编译时已丢失，无法恢复；经过混淆的模组可读性有限。</p>
          </div>
        ) : null}
        {obfuscationBanner}
        {progress && running ? (
          <div className="decompile-progress">
            <Loader2 className="spin" size={15} />
            <span>{progress.message}</span>
            <div className="decompile-progress-bar"><div style={{ width: `${Math.round((progress.ratio ?? 0.05) * 100)}%` }} /></div>
            <button className="secondary-button" type="button" onClick={() => { if (inspectedRef.current) void window.modmind.decompile.cancel(inspectedRef.current.filePath) }}>
              取消
            </button>
          </div>
        ) : null}
        {inspect && !running ? (
          <>
            <div className="decompile-jar-summary">
              <CheckCircle2 size={15} />
              <strong>{inspect.displayName || inspect.fileName}</strong>
              <span className="muted">{inspect.loader ?? '未知加载器'} · {inspect.classCount} 个类 · {formatBytes(inspect.size)}</span>
              {inspect.remapRecommended ? <label className="decompile-check"><input type="checkbox" checked={!skipRemap} onChange={(event) => setSkipRemap(!event.target.checked)} /> 先重映射为可读名称</label> : null}
              <input
                className="decompile-mc-input"
                placeholder="Minecraft 版本，如 1.21.1"
                value={mcVersionInput}
                onChange={(event) => setMcVersionInput(event.target.value)}
              />
              <button className={takeoverFlow ? 'secondary-button' : 'primary-button'} type="button" disabled={running || (!!inspect.remapRecommended && !mcVersionInput.trim() && !skipRemap)} onClick={() => void runPipeline(inspect.filePath, { skipRemap, ...(mcVersionInput.trim() ? { minecraftVersion: mcVersionInput.trim() } : {}) })}>
                <RefreshCw size={14} /> {takeoverFlow ? '仅反编译浏览' : '开始反编译'}
              </button>
              <button className="secondary-button" type="button" onClick={() => void scanReferences()}>
                <FileSearch size={14} /> 分析依赖引用
              </button>
              {files.length && projectContext?.kind === 'modpack' ? (
                <button className="secondary-button" type="button" disabled={running} onClick={() => void openTermsDialog()} title="把反编译源码导出为整合包的自制模组模块">
                  <PackagePlus size={14} /> 转为自制模组
                </button>
              ) : null}
              {files.length ? (
                <button className={takeoverFlow ? 'primary-button' : 'secondary-button'} type="button" disabled={running} onClick={() => void openTermsDialog('project')} title="将反编译源码转换为 ModMind 项目">
                  <PackagePlus size={14} /> 转换为 ModMind 项目
                </button>
              ) : null}
              {!files.length && takeoverFlow ? (
                <button className="primary-button" type="button" disabled={running || inspecting || !mcVersionInput.trim()} onClick={() => void startAndConvertProject()}>
                  <PackagePlus size={14} /> 反编译并接管
                </button>
              ) : null}
            </div>
            {exportNotice ? (
              <div className="decompile-banner" role="status"><ShieldCheck size={15} /><span>{exportNotice}</span></div>
            ) : null}
            {files.length ? (
              <div className="decompile-notice">
                <Lock size={13} />
                <span>反编译结果，不是项目源码（来源 sha256: {inspect.sha256.slice(0, 12)}…，只读）</span>
              </div>
            ) : null}
          </>
        ) : null}
        {files.length ? (
          <div className="decompile-content">
            <div className="decompile-file-pane">
              <div className="decompile-search">
                <Search size={14} />
                <input placeholder="按文件名过滤…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
              </div>
              <div className="decompile-tree">
                <TreeView node={filteredTree} depth={0} selectedPath={selectedFile?.relativePath ?? null} onSelect={(file) => { if (inspectedRef.current) void selectAndLoad(inspectedRef.current.sha256, file) }} />
              </div>
            </div>
            <div className="decompile-editor-pane">
              <div className="decompile-editor-toolbar">
                <input
                  className="decompile-fulltext"
                  placeholder="全文搜索（回车执行，前 300 条命中）…"
                  onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }}
                  onChange={(event) => setFullTextQuery(event.target.value)}
                />
                {searchResults ? <small>{searchResults.length} 条命中</small> : null}
              </div>
              {searchResults ? (
                <div className="decompile-search-results">
                  {searchResults.map((hit) => (
                    <button key={`${hit.relativePath}:${hit.line}`} type="button" onClick={() => {
                      const target = files.find((file) => file.relativePath === hit.relativePath)
                      if (target && inspectedRef.current) void selectAndLoad(inspectedRef.current.sha256, target)
                    }}>
                      <code>{hit.relativePath}:{hit.line}</code>
                      <pre>{hit.text}</pre>
                    </button>
                  ))}
                </div>
              ) : loadingFile ? (
                <div className="decompile-loading"><Loader2 className="spin" size={18} /></div>
              ) : selectedFile ? (
                <MonacoCodeEditor
                  path={`decompile://${selectedFile.relativePath}`}
                  language="java"
                  value={fileContent}
                  darkMode={darkMode}
                  onChange={() => undefined}
                  onSave={() => undefined}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
      {termsDialogOpen && terms ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!exportBusy) setTermsDialogOpen(false) }}>
          <div className="dialog decompile-terms-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-header">
              <div><h2><Lock size={16} /> {terms.title}</h2><p>条款版本 {terms.version} · 在导出前必须完整阅读并确认</p></div>
              <button className="icon-button" type="button" title="关闭" disabled={exportBusy} onClick={() => setTermsDialogOpen(false)}><X size={17} /></button>
            </div>
            <div className="decompile-terms-body">
              {terms.sections.map((section) => (
                <section key={section.heading}>
                  <h4>{section.heading}</h4>
                  {section.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                </section>
              ))}
              <p className="decompile-terms-source">来源 JAR：{inspectedRef.current?.fileName ?? ''}（sha256: {(inspectedRef.current?.sha256 ?? '').slice(0, 16)}…）。接受记录会写入生成的{termsTarget === 'project' ? '项目' : '模块'}目录。</p>
            </div>
            <label className="field-label">{termsTarget === 'project' ? '项目名称' : '新模块名称'}
              <input value={moduleNameInput} onChange={(event) => setModuleNameInput(event.target.value)} placeholder="例如：Cool Mod" />
              <small>{termsTarget === 'project' ? '会创建标准 ModMind 工程，并把反编译源码写入 src/main/java' : '将创建为整合包 modules/ 目录下的独立自制模组工程'}</small>
            </label>
            {termsTarget === 'project' ? <div className="adopt-fields">
              <label className="field-label">Minecraft 版本
                <input value={projectMinecraftVersion} onChange={(event) => setProjectMinecraftVersion(event.target.value)} placeholder="例如：1.21.1" />
              </label>
              <label className="field-label">加载器
                <select value={projectLoader} onChange={(event) => setProjectLoader(event.target.value as JavaLoaderKind)}>
                  <option value="fabric">Fabric</option>
                  <option value="quilt">Quilt</option>
                  <option value="forge">Forge</option>
                  <option value="neoforge">NeoForge</option>
                </select>
              </label>
            </div> : null}
            {exportNotice ? <div className="inline-error"><CircleAlert size={15} />{exportNotice}</div> : null}
            <div className="dialog-footer">
              <button className="secondary-button" type="button" disabled={exportBusy} onClick={() => setTermsDialogOpen(false)}>取消</button>
              <button className="primary-button decompile-danger-confirm" type="button" disabled={exportBusy || !moduleNameInput.trim() || (termsTarget === 'project' && !projectMinecraftVersion.trim())} onClick={() => void (termsTarget === 'project' ? confirmCreateProject() : confirmExportModule())}>
                {exportBusy ? <Loader2 className="spin" size={15} /> : <PackagePlus size={15} />}
                {termsTarget === 'project' ? '我已阅读并同意，创建 ModMind 项目' : '我已阅读并同意，导出为自制模组'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
