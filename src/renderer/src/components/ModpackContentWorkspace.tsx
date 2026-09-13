import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  Archive,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  FileCode2,
  FileCog,
  FileJson,
  FolderOpen,
  Image,
  LoaderCircle,
  Plus,
  RefreshCw,
  MonitorCog,
  PackageOpen,
  Save,
  ServerCog,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles
} from 'lucide-react'
import type { ModpackContentInventory, ModpackContentItem, ModpackContentKind, ModpackContentScope, ModpackManifest, ProjectInfo, ServerPackManifest } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'
import { cachedModpackContent, loadModpackContent } from '../modpackContentCache'
import ContentTextEditor, { type ContentEditorHandle } from './ContentTextEditor'
import { contentDraftKey, setContentDraft } from '../lib/contentDrafts'
import ResourceImagePreview from './ResourceImagePreview'
import { configModAssociation, type ModConfigIdentity } from '../../../shared/contentFileFilters'
import '../resource-packs.css'
import '../content-workspace.css'

export type ModpackContentSection = Exclude<ModpackContentKind, 'quests'>

type TargetRequirement = { label: string; matches: string[] }
type TargetPreset = { label: string; path: string; scope?: ModpackContentScope; file?: boolean; requirement?: TargetRequirement }
type StarterFile = { label: string; path: string; content?: (project: ProjectInfo) => string }
type ContentTone = 'datapack' | 'resourcepack' | 'shaderpack' | 'world' | 'utility'
type SectionInfo = {
  label: string
  description: string
  icon: typeof FileJson
  path: string
  targets: TargetPreset[]
  starters: StarterFile[]
  mode: 'editor' | 'assets'
  scopeOptions: ModpackContentScope[]
  tone: ContentTone
  addLabel: string
  emptyTitle: string
  emptyDescription: string
  supportsExtract?: boolean
}

function dataPackFormat(minecraftVersion: string): number {
  if (minecraftVersion === '1.20.1') return 15
  if (minecraftVersion === '1.20.6') return 41
  return 48
}

function dataPackMetadata(project: ProjectInfo): string {
  return `${JSON.stringify({ pack: { pack_format: dataPackFormat(project.minecraftVersion), description: `${project.name} data pack` } }, null, 2)}\n`
}

const sectionInfo: Record<ModpackContentSection, SectionInfo> = {
  config: { label: '配置与默认项', description: 'config · defaultconfigs · serverconfig', icon: FileCog, path: 'config/', targets: [{ label: '通用配置', path: 'config' }, { label: '默认配置', path: 'defaultconfigs' }, { label: '服务端配置', path: 'serverconfig', scope: 'server' }], starters: [{ label: '通用配置', path: 'config/pack.toml' }, { label: '默认配置', path: 'defaultconfigs/pack.toml' }], mode: 'editor', scopeOptions: ['common', 'client', 'server'], tone: 'utility', addLabel: '添加配置', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' },
  scripts: { label: '脚本与 KubeJS', description: 'KubeJS 与启动脚本', icon: Braces, path: 'kubejs/', targets: [{ label: '全部 KubeJS', path: 'kubejs' }, { label: '服务端脚本', path: 'kubejs/server_scripts', scope: 'server' }, { label: '客户端脚本', path: 'kubejs/client_scripts', scope: 'client' }, { label: '启动脚本', path: 'kubejs/startup_scripts' }, { label: '资源 assets', path: 'kubejs/assets', scope: 'client' }, { label: '数据 data', path: 'kubejs/data' }, { label: '其他脚本 / CraftTweaker', path: 'scripts' }], starters: [{ label: '服务端脚本', path: 'kubejs/server_scripts/pack.js' }, { label: '客户端脚本', path: 'kubejs/client_scripts/pack.js' }, { label: '启动脚本', path: 'kubejs/startup_scripts/pack.js' }], mode: 'editor', scopeOptions: ['common', 'client', 'server'], tone: 'utility', addLabel: '添加脚本', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' },
  datapacks: { label: '数据包', description: 'datapacks · OpenLoader · Paxi', icon: FileJson, path: 'datapacks/', targets: [{ label: '数据包', path: 'datapacks' }, { label: 'OpenLoader', path: 'openloader/data', requirement: { label: 'OpenLoader', matches: ['openloader'] } }, { label: 'Paxi', path: 'paxi/datapacks', requirement: { label: 'Paxi', matches: ['paxi'] } }], starters: [{ label: '数据包描述', path: 'datapacks/pack.mcmeta', content: dataPackMetadata }, { label: '函数文件', path: 'datapacks/data/example/functions/start.mcfunction', content: () => '# Runs from your data pack.\n' }], mode: 'editor', scopeOptions: ['common', 'client', 'server'], tone: 'utility', addLabel: '添加数据包', emptyTitle: '暂无数据包内容', emptyDescription: '从描述文件或函数入口开始，完成后可在代码编辑器中继续编辑' },
  resourcepacks: { label: '资源包', description: '客户端视觉资源', icon: Image, path: 'resourcepacks/', targets: [{ label: '资源包', path: 'resourcepacks', scope: 'client' }], starters: [], mode: 'assets', scopeOptions: ['client'], tone: 'utility', addLabel: '添加资源包', emptyTitle: '暂无资源包', emptyDescription: '导入或下载 ZIP 资源包后，它会以客户端内容随整合包分发' },
  shaderpacks: { label: '光影包', description: 'shaderpacks · 客户端内容', icon: Sparkles, path: 'shaderpacks/', targets: [{ label: '光影包', path: 'shaderpacks', scope: 'client' }], starters: [], mode: 'assets', scopeOptions: ['client'], tone: 'utility', addLabel: '添加光影包', emptyTitle: '暂无光影包', emptyDescription: '导入或下载 ZIP 光影包后，它会以客户端内容随整合包分发' },
  ui: { label: '界面资源', description: 'FancyMenu 与默认界面资源', icon: MonitorCog, path: 'fancymenu_data/', targets: [{ label: 'FancyMenu', path: 'fancymenu_data', scope: 'client' }, { label: '资源包', path: 'resourcepacks', scope: 'client' }], starters: [{ label: '界面布局', path: 'fancymenu_data/layouts/pack.txt' }, { label: '默认选项', path: 'defaultoptions/options.txt' }], mode: 'editor', scopeOptions: ['client'], tone: 'utility', addLabel: '添加界面资源', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' },
  worlds: { label: '存档与世界', description: '初始世界与可导入存档', icon: Save, path: 'saves/', targets: [{ label: '初始世界', path: 'saves' }], starters: [], mode: 'assets', scopeOptions: ['common'], tone: 'utility', addLabel: '添加世界', emptyTitle: '暂无初始世界', emptyDescription: '导入包含 level.dat 的世界目录，或下载并解压 ZIP 世界', supportsExtract: true },
  client: { label: '玩家预设', description: '键位、选项与客户端默认项', icon: SlidersHorizontal, path: 'options.txt', targets: [{ label: '游戏选项', path: 'options.txt', scope: 'client', file: true }, { label: '按键预设', path: 'options.txt', scope: 'client', file: true }, { label: '光影选项', path: 'optionsshaders.txt', scope: 'client', file: true }], starters: [{ label: '游戏选项', path: 'options.txt' }], mode: 'editor', scopeOptions: ['client'], tone: 'utility', addLabel: '添加玩家预设', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' },
  server: { label: '服务端配置', description: 'serverconfig 与服务端默认项', icon: ServerCog, path: 'serverconfig/', targets: [{ label: '服务端配置', path: 'serverconfig', scope: 'server' }, { label: '默认配置', path: 'defaultconfigs', scope: 'server' }], starters: [{ label: '服务端配置', path: 'serverconfig/pack.toml' }, { label: '默认配置', path: 'defaultconfigs/pack.toml' }], mode: 'editor', scopeOptions: ['server'], tone: 'utility', addLabel: '添加服务端配置', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' },
  other: { label: '文件工作台', description: '未归类的 MRPack 覆盖文件', icon: Boxes, path: '', targets: [{ label: '自定义位置', path: '' }, { label: '全局资源', path: 'global_packs' }], starters: [{ label: '说明文件', path: 'README.txt' }], mode: 'editor', scopeOptions: ['common', 'client', 'server'], tone: 'utility', addLabel: '添加内容', emptyTitle: '暂无工作文件', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' }
}

const editableExtensions = new Set(['cfg', 'conf', 'ini', 'js', 'json', 'json5', 'mcmeta', 'md', 'kts', 'lang', 'mcfunction', 'properties', 'snbt', 'toml', 'ts', 'txt', 'xml', 'yaml', 'yml', 'zs'])
const CONTENT_ROW_HEIGHT = 44
const CONTENT_ROW_OVERSCAN = 8

function formatBytes(value?: number): string {
  if (!value) return '大小未知'
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}

function defaultScope(kind: ModpackContentSection): ModpackContentScope {
  return ['resourcepacks', 'shaderpacks', 'ui', 'client'].includes(kind) ? 'client' : kind === 'server' ? 'server' : 'common'
}

function targetHint(target: TargetPreset, sourceUrl: string, extractWorld = false): string {
  if (target.file) return target.path
  if (!sourceUrl.trim()) return ''
  try {
    const rawName = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1) ?? '')
    const name = extractWorld ? rawName.replace(/\.(?:zip|mcworld)$/i, '') || rawName : rawName
    return target.path && name ? `${target.path}/${name}` : name
  } catch {
    return ''
  }
}

function isEditableContent(item: ModpackContentItem): boolean {
  if (item.directory) return false
  const extension = item.path.split('.').at(-1)?.toLowerCase()
  return Boolean(extension && editableExtensions.has(extension))
}

export default function ModpackContentWorkspace({ project, section, onOpenEditor, onCreateFile, inventoryMode = false, darkMode = false }: { project: ProjectInfo; section: ModpackContentSection; onOpenEditor: (contentPath?: string) => void; onCreateFile: (contentPath: string, content?: string) => void; inventoryMode?: boolean; darkMode?: boolean }): React.JSX.Element {
  const info = inventoryMode ? { label: '文件清单', description: 'MRPack 远程来源与本地覆盖内容', icon: PackageOpen, path: '', targets: [{ label: '自定义位置', path: '' }, { label: '全局资源', path: 'global_packs' }], starters: [{ label: '说明文件', path: 'README.txt' }], mode: 'editor', scopeOptions: ['common', 'client', 'server'], tone: 'utility', addLabel: '添加内容', emptyTitle: '暂无内容', emptyDescription: '新建或导入文件后，可直接在代码编辑器中继续编辑' } satisfies SectionInfo : sectionInfo[section]
  const Icon = info.icon
  const editorRef = useRef<ContentEditorHandle | null>(null)
  const openCodeEditor = async (contentPath?: string): Promise<void> => {
    if (editorRef.current && !await editorRef.current.save()) return
    onOpenEditor(contentPath)
  }
  const [inventory, setInventory] = useState<ModpackContentInventory>({ version: 1, items: [] })
  const [manifest, setManifest] = useState<ModpackManifest | null>(null)
  const [serverPackManifest, setServerPackManifest] = useState<ServerPackManifest | null>(null)
  const [serverPackModsExpanded, setServerPackModsExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [fileFilter, setFileFilter] = useState('all')
  const [modFilter, setModFilter] = useState('all')
  const [modIdentities, setModIdentities] = useState<ModConfigIdentity[]>([])
  const [modsLoading, setModsLoading] = useState(false)
  const [modsError, setModsError] = useState('')
  const supportsModFilter = !inventoryMode && (section === 'config' || section === 'server')
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [initialLoading, setInitialLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [url, setUrl] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [targetIndex, setTargetIndex] = useState(0)
  const [targetIsSuggested, setTargetIsSuggested] = useState(false)
  const [scope, setScope] = useState<ModpackContentScope>(() => defaultScope(section))
  const [extract, setExtract] = useState(section === 'worlds')
  const downloadInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [listScrollTop, setListScrollTop] = useState(0)
  const [listViewportHeight, setListViewportHeight] = useState(336)
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()

  const load = async (isCurrent: () => boolean = () => true, refresh = false): Promise<void> => {
    const [nextInventory, nextManifest, nextServerPack] = await Promise.all([
      loadModpackContent(project.path, refresh),
      window.modmind.modpack.get(),
      section === 'server' ? window.modmind.modpack.getServerPackManifest() : Promise.resolve(null)
    ])
    if (!isCurrent()) return
    setInventory(nextInventory)
    setManifest(nextManifest)
    setServerPackManifest(nextServerPack)
  }

  useEffect(() => {
    let current = true
    setScope(info.scopeOptions[0] ?? defaultScope(section))
    setTargetPath('')
    setTargetIndex(0)
    setTargetIsSuggested(false)
    setSelectedId(''); setQuery(''); setFileFilter('all'); setModFilter('all'); setDownloadOpen(false)
    setExtract(section === 'worlds')
    setServerPackModsExpanded(false)
    const cached = cachedModpackContent(project.path)
    if (cached) {
      setInventory(cached)
      setInitialLoading(false)
      void Promise.all([
        window.modmind.modpack.get(),
        section === 'server' ? window.modmind.modpack.getServerPackManifest() : Promise.resolve(null)
      ])
        .then(([nextManifest, nextServerPack]) => {
          if (!current) return
          setManifest(nextManifest)
          setServerPackManifest(nextServerPack)
        })
        .catch((error) => { if (current) setNotice(error instanceof Error ? error.message : String(error)) })
    } else {
      setInitialLoading(true)
      void load(() => current)
        .catch((error) => { if (current) setNotice(error instanceof Error ? error.message : String(error)) })
        .finally(() => { if (current) setInitialLoading(false) })
    }
    return () => { current = false }
  }, [project.path, section, inventoryMode])

  useEffect(() => {
    let current = true
    setModIdentities([])
    setModsError('')
    setModFilter('all')
    setModsLoading(supportsModFilter)
    if (supportsModFilter) void window.modmind.modpack.configModIdentities(project.path)
      .then(mods => { if (current) setModIdentities(mods) })
      .catch(() => { if (current) setModsError('模组识别失败，请刷新重试') })
      .finally(() => { if (current) setModsLoading(false) })
    return () => { current = false }
  }, [project.path, supportsModFilter, previewRevision])

  useEffect(() => {
    const element = listRef.current
    if (!element) return
    const measure = (): void => setListViewportHeight(element.clientHeight || 336)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
    setListScrollTop(0)
  }, [project.path, section])

  const items = useMemo(() => inventoryMode ? inventory.items : inventory.items.filter((item) => item.kind === section || (section === 'server' && /^(serverconfig|defaultconfigs)\//.test(item.path))), [inventory.items, inventoryMode, section])
  const { remote, total } = useMemo(() => ({
    remote: items.filter((item) => item.delivery === 'remote').length,
    total: items.reduce((sum, item) => sum + (item.size ?? 0), 0)
  }), [items])
  const filters = useMemo(() => inventoryMode
    ? [...new Set(items.map(item => item.kind))].map(kind => ({ value: kind, label: sectionInfo[kind as ModpackContentSection]?.label ?? '任务文件' }))
    : info.targets.filter(target => target.path).map(target => ({ value: target.path, label: target.label })), [inventoryMode, items, info.targets])
  const associations = useMemo(() => new Map(items.map(item => [item.id, configModAssociation(item.path, modIdentities)])), [items, modIdentities])
  const modOptions = useMemo(() => {
    const counts = new Map<string, { mod: ModConfigIdentity; count: number }>()
    for (const mod of associations.values()) if (mod) {
      const entry = counts.get(mod.id) ?? { mod, count: 0 }
      entry.count++
      counts.set(mod.id, entry)
    }
    return [...counts.values()].sort((a, b) => a.mod.name.localeCompare(b.mod.name))
  }, [associations])
  const filteredItems = useMemo(() => items.filter(item => {
    const matchesFilter = fileFilter === 'all' || (inventoryMode ? item.kind === fileFilter : item.path === fileFilter || item.path.startsWith(`${fileFilter}/`))
    const mod = associations.get(item.id)
    const matchesMod = !supportsModFilter || modFilter === 'all' || (modFilter === 'unassigned' ? !mod : `mod:${mod?.id}` === modFilter)
    return matchesFilter && matchesMod && item.path.toLowerCase().includes(query.trim().toLowerCase())
  }), [items, inventoryMode, fileFilter, query, associations, supportsModFilter, modFilter])
  const selectedItem = filteredItems.find(item => item.id === selectedId)
  useEffect(() => {
    setSelectedId(current => filteredItems.some(item => item.id === current) ? current : filteredItems[0]?.id ?? '')
  }, [filteredItems])
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); setListScrollTop(0) }, [query, fileFilter, modFilter])
  const virtualRange = useMemo(() => {
    const visibleRows = Math.ceil(listViewportHeight / CONTENT_ROW_HEIGHT)
    const start = Math.max(0, Math.floor(listScrollTop / CONTENT_ROW_HEIGHT) - CONTENT_ROW_OVERSCAN)
    return { start, end: Math.min(filteredItems.length, start + visibleRows + CONTENT_ROW_OVERSCAN * 2) }
  }, [filteredItems.length, listScrollTop, listViewportHeight])
  const visibleItems = filteredItems.slice(virtualRange.start, virtualRange.end)
  const editorFirst = info.mode === 'editor'
  const selectedTarget = info.targets[targetIndex]
  const targetRequirement = selectedTarget?.requirement
  const targetDependencyMissing = Boolean(targetRequirement && manifest && !manifest.mods.some((mod) => targetRequirement.matches.some((match) => mod.fileName.toLowerCase().includes(match))))

  const run = (key: string, action: () => Promise<void>): void => {
    if (busy) return
    setBusy(key)
    setNotice('')
    void action().catch((error) => setNotice(error instanceof Error ? error.message : String(error))).finally(() => setBusy(''))
  }

  const addServerPackMods = (): void => run('server-mod-add', async () => {
    const updated = await window.modmind.modpack.addServerPackMods()
    if (!updated) return
    setServerPackManifest(updated)
    setNotice(`服务端 Mod 已更新：${updated.mods.length} 个`)
  })

  const exportServerPack = (): void => run('server-export', async () => {
    const target = await window.modmind.modpack.exportServerPack()
    if (target) setNotice(`服务端包已导出：${target}`)
  })

  const removeServerPackModFile = async (fileName: string): Promise<void> => {
    if (busy || !await requestConfirm({ title: `移除“${fileName}”`, message: '该 Mod 将从当前服务端包删除', confirmLabel: '移除 Mod', tone: 'danger' })) return
    run(`server-mod-remove:${fileName}`, async () => {
      const updated = await window.modmind.modpack.removeServerPackMod(fileName)
      setServerPackManifest(updated)
      setNotice(`服务端 Mod 已更新：${updated.mods.length} 个`)
    })
  }

  const importLocal = (): void => run('import', async () => {
    const result = await window.modmind.modpack.importContent(section, scope)
    if (result) {
      await load(() => true, true)
      setNotice(`已导入 ${result.copiedFiles} 个文件`)
    }
  })

  const download = (): void => run('download', async () => {
    if (!url.trim()) throw new Error('请输入 HTTPS 下载地址')
    if (targetDependencyMissing) throw new Error(`当前整合包未安装 ${targetRequirement?.label}，不能使用该目标位置`)
    const suggestedPath = targetHint(selectedTarget, url, section === 'worlds' && extract)
    const destination = (targetPath.trim() || suggestedPath).replaceAll('\\', '/')
    const existing = destination ? inventory.items.find((item) => item.path === destination) : undefined
    if (existing && !await requestConfirm({ title: '替换已管理内容？', message: '下载会替换现有内容，替换后无法自动恢复', detail: existing.path, confirmLabel: '替换内容', cancelLabel: '保留现有内容', tone: 'danger' })) return
    const result = await window.modmind.modpack.downloadContent({ kind: section, scope, url: url.trim(), ...(targetPath.trim() ? { targetPath: targetPath.trim() } : {}), ...(extract ? { extract: true } : {}) })
    await load(() => true, true)
    setTargetPath('')
    setTargetIsSuggested(false)
    setNotice(`已下载 ${result.item.path}${result.extractedFiles ? `，已解压 ${result.extractedFiles} 个文件` : ''}`)
  })

  const remove = async (item: ModpackContentItem): Promise<void> => {
    if (busy || !await requestConfirm({ title: '移除已管理内容？', message: '这会从整合包中删除文件或目录，且无法自动恢复', detail: item.path, confirmLabel: '移除内容', cancelLabel: '保留内容', tone: 'danger' })) return
    run(`remove:${item.id}`, async () => {
    const relative = await window.modmind.modpack.contentProjectPath(item.path)
    await window.modmind.modpack.removeContent(item.id)
    setContentDraft(contentDraftKey(project.path, relative), undefined)
    await load(() => true, true)
    })
  }

  const selectTarget = (index: number): void => {
    const target = info.targets[index]
    setTargetIndex(index)
    setTargetPath(targetHint(target, url, section === 'worlds' && extract))
    setTargetIsSuggested(true)
    setScope(target.scope ?? info.scopeOptions[0] ?? defaultScope(section))
  }

  useEffect(() => { if (downloadOpen) downloadInputRef.current?.focus() }, [downloadOpen])

  const renderServerPackManager = section === 'server' ? (() => {
    const rows = serverPackManifest?.mods ?? []
    return <section className={`server-pack-config-panel${serverPackModsExpanded ? ' expanded' : ''}`}>
      <div className="server-pack-config-heading">
        <div className="server-pack-config-title"><span><ServerCog size={18} /></span><div><h2>服务端 Mod</h2><p>{serverPackManifest ? `${rows.length} 个已同步 Mod` : '尚未同步服务端包'}</p></div></div>
        <div className="server-pack-config-actions"><button className="secondary-button compact" type="button" disabled={Boolean(busy) || !serverPackManifest} onClick={addServerPackMods}>{busy === 'server-mod-add' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}添加 Mod</button><button className="primary-button compact" type="button" disabled={Boolean(busy) || !serverPackManifest} onClick={exportServerPack}>{busy === 'server-export' ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}导出 ZIP</button><button className={`icon-button server-pack-config-toggle${serverPackModsExpanded ? ' expanded' : ''}`} type="button" title={serverPackModsExpanded ? '收起服务端 Mod 清单' : '展开服务端 Mod 清单'} aria-label={serverPackModsExpanded ? '收起服务端 Mod 清单' : '展开服务端 Mod 清单'} aria-expanded={serverPackModsExpanded} disabled={!serverPackManifest} onClick={() => setServerPackModsExpanded((expanded) => !expanded)}><ChevronDown size={16} /></button></div>
      </div>
      {serverPackModsExpanded ? <div className="server-pack-config-list">{rows.length ? rows.map((fileName) => <div className="server-pack-config-row" key={fileName}><span className="server-pack-config-mod-icon"><PackageOpen size={16} /></span><div><strong title={fileName}>{fileName}</strong><small>服务端 Mod</small></div><button className="icon-button danger" type="button" title={`移除 ${fileName}`} aria-label={`移除 ${fileName}`} disabled={Boolean(busy)} onClick={() => void removeServerPackModFile(fileName)}>{busy === `server-mod-remove:${fileName}` ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button></div>) : <div className="server-pack-config-empty">当前服务端包没有 Mod</div>}</div> : null}
    </section>
  })() : null

  const downloadControls = <>
    <div className="pack-content-download-row">
      <label>下载地址<input ref={downloadInputRef} value={url} inputMode="url" placeholder="https://..." onChange={(event) => { setUrl(event.target.value); if (!targetPath || targetIsSuggested) { setTargetPath(targetHint(info.targets[targetIndex], event.target.value, section === 'worlds' && extract)); setTargetIsSuggested(true) } }} /></label>
      <label>目标路径<input value={targetPath} placeholder={info.targets[targetIndex]?.file ? info.targets[targetIndex].path : info.path || '相对路径'} onChange={(event) => { setTargetPath(event.target.value); setTargetIsSuggested(false) }} /></label>
      {info.scopeOptions.length > 1 ? <label>分发环境<select value={scope} onChange={(event) => setScope(event.target.value as ModpackContentScope)}>{info.scopeOptions.map((option) => <option key={option} value={option}>{option === 'common' ? '通用' : option === 'client' ? '客户端' : '服务端'}</option>)}</select></label> : <span className="pack-content-scope-lock"><CheckCircle2 size={14} />{scope === 'client' ? '仅客户端' : scope === 'server' ? '仅服务端' : '通用内容'}</span>}
      {info.supportsExtract ? <label className="check-row"><input type="checkbox" checked={extract} onChange={(event) => { const next = event.target.checked; setExtract(next); if (targetIsSuggested) setTargetPath(targetHint(info.targets[targetIndex], url, next)) }} />解压 ZIP 世界</label> : null}
      <button className="primary-button" disabled={Boolean(busy) || !url.trim() || targetDependencyMissing} onClick={download}>{busy === 'download' ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}下载</button>
    </div>
    <div className="pack-content-targets" aria-label="常用目标路径"><span>目标位置</span>{info.targets.map((target, index) => <button type="button" className={targetIndex === index ? 'active' : ''} key={`${target.label}:${target.path}`} onClick={() => selectTarget(index)} title={target.path || '下载后填写相对路径'}>{target.label}</button>)}</div>
    {targetDependencyMissing ? <div className="pack-content-requirement" role="status"><Archive size={14} />“{selectedTarget.label}”需要已安装 {targetRequirement?.label}</div> : null}
  </>

  const reveal = (item: ModpackContentItem): void => run('reveal', async () => {
    const relative = await window.modmind.modpack.contentProjectPath(item.path)
    await window.modmind.project.reveal(relative, project.path)
  })

  return <div className="resource-pack-workspace pack-content-workspace">
    <header className="content-toolbar">
      <div><h1>{info.label}</h1><p>{project.name} · {project.minecraftVersion}</p></div>
      <div className="resource-pack-actions">
        <button className="icon-button" title="刷新内容列表" disabled={Boolean(busy) || initialLoading} onClick={() => run('refresh', async () => { await load(() => true, true); setPreviewRevision(value => value + 1) })}><RefreshCw size={16} /></button>
        {info.starters.length ? <label className="pack-content-create"><Plus size={15} /><select aria-label="新建文件" value="" disabled={Boolean(busy)} onChange={event => { const starter = info.starters.find(item => item.path === event.target.value); if (starter) onCreateFile(starter.path, starter.content?.(project)) }}><option value="" disabled>新建文件</option>{info.starters.map(starter => <option key={starter.path} value={starter.path}>{starter.label}</option>)}</select></label> : null}
        <button className="secondary-button" disabled={Boolean(busy)} onClick={importLocal}><Upload size={15} />{section === 'worlds' ? '导入世界目录' : '导入文件'}</button>
        <button className="secondary-button" aria-expanded={downloadOpen} aria-controls="pack-content-download" onClick={() => setDownloadOpen(value => !value)}><CloudDownload size={15} />从链接添加</button>
      </div>
    </header>
    <div className="resource-pack-toolbar">
      <label>文件范围<select aria-label="文件范围" value={fileFilter} onChange={event => setFileFilter(event.target.value)}><option value="all">全部{inventoryMode ? '内容' : '文件'}</option>{filters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label>
      {supportsModFilter ? <label title={modsError || '根据已安装模组 ID 与配置文件名或目录名匹配；未匹配的文件仍可查看'}>关联模组<select aria-label="关联模组" value={modFilter} disabled={modsLoading || Boolean(modsError)} onChange={event => setModFilter(event.target.value)}><option value="all">{modsLoading ? '正在识别模组…' : modsError || '全部模组 / 配置'}</option>{modOptions.map(({ mod, count }) => <option key={mod.id} value={`mod:${mod.id}`}>{mod.name} ({mod.id}) · {count}</option>)}<option value="unassigned">未识别 / 共享配置 · {items.length - [...associations.values()].filter(Boolean).length}</option></select></label> : null}
      <span>{initialLoading ? '正在加载…' : `${filteredItems.length} 项内容`}</span>
      <span className="resource-pack-origin">{remote ? `${remote} 个远程来源 · ` : ''}{items.length ? formatBytes(total) : info.description}</span>
      <div className="resource-pack-actions"><button className="secondary-button" onClick={() => void openCodeEditor(selectedItem && isEditableContent(selectedItem) ? selectedItem.path : undefined)}><FileCode2 size={15} />代码编辑器</button></div>
    </div>
    {downloadOpen ? <section id="pack-content-download" className="pack-content-download-panel" aria-label="从链接添加内容">{downloadControls}</section> : null}
    {renderServerPackManager}
    <div className="resource-pack-body">
      <aside className="resource-pack-files pack-content-files" aria-label="内容文件列表">
        <div className="resource-pack-file-tools"><input aria-label="筛选内容文件" placeholder="筛选文件" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="pack-content-file-list" ref={listRef} onScroll={event => setListScrollTop(event.currentTarget.scrollTop)}>
          {initialLoading ? <div className="pack-content-list-message" role="status"><LoaderCircle className="spin" size={16} />正在读取文件…</div> : null}
          {!initialLoading && filteredItems.length ? <div className="pack-content-virtual" style={{ height: filteredItems.length * CONTENT_ROW_HEIGHT }}><div className="pack-content-virtual-window" style={{ transform: `translateY(${virtualRange.start * CONTENT_ROW_HEIGHT}px)` }}>{visibleItems.map(item => {
            const ItemIcon = item.directory ? FolderOpen : contentVisual(item).Icon
            return <button key={item.id} className={`resource-pack-file pack-content-file${selectedId === item.id ? ' active' : ''}`} aria-pressed={selectedId === item.id} title={item.path} onClick={() => setSelectedId(item.id)}>
              <ItemIcon size={15} /><span><strong>{item.path}</strong><small>{inventoryMode ? `${contentVisual(item).label} · ` : ''}{item.delivery === 'remote' ? '远程已校验' : item.directory ? '目录内容' : '本地覆盖'} · {scopeLabel(item.scope)}</small></span>
            </button>
          })}</div></div> : null}
          {!initialLoading && !filteredItems.length ? <div className="pack-content-list-message">{items.length ? '没有匹配的文件' : info.emptyTitle}</div> : null}
        </div>
      </aside>
      <section className="resource-pack-editor" aria-label="文件编辑与详情">
        <div className="resource-pack-editor-heading"><span>{selectedItem?.path ?? '选择文件'}</span>{selectedItem ? <div className="resource-pack-actions">
          {selectedItem.sourceUrl ? <button className="icon-button" title="打开来源" onClick={() => void window.open(selectedItem.sourceUrl, '_blank')}><WandSparkles size={15} /></button> : null}
          <button className="icon-button" title="在文件管理器中显示" disabled={Boolean(busy)} onClick={() => reveal(selectedItem)}><FolderOpen size={16} /></button>
          <button className="icon-button danger" title="移除内容" disabled={Boolean(busy)} onClick={() => void remove(selectedItem)}><Trash2 size={15} /></button>
        </div> : null}</div>
        {selectedItem && !initialLoading ? <ContentPreview key={`${project.path}:${selectedItem.id}`} projectPath={project.path} item={selectedItem} darkMode={darkMode} revision={previewRevision} editorRef={editorRef} mod={supportsModFilter ? associations.get(selectedItem.id) : undefined} /> : <div className="resource-pack-empty"><Icon size={28} /><p>{initialLoading ? '正在加载内容…' : items.length ? '选择文件以查看内容' : info.emptyTitle}</p><small>{items.length ? '可在左侧筛选或切换文件范围' : info.emptyDescription}</small><div className="resource-pack-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={importLocal}><Upload size={15} />{section === 'worlds' ? '导入世界目录' : '导入文件'}</button>{editorFirst ? <button className="secondary-button" onClick={() => void openCodeEditor()}><FileCode2 size={15} />代码编辑器</button> : null}</div></div>}
      </section>
    </div>
    {notice || busy ? <div className="resource-pack-notice" role="status">{busy ? <LoaderCircle className="spin" size={15} /> : null}{notice || '处理中…'}</div> : null}
    {confirmDialog}
  </div>
}

function scopeLabel(scope: ModpackContentScope): string { return scope === 'common' ? '通用' : scope === 'client' ? '客户端' : '服务端' }

function contentVisual(item: ModpackContentItem): { Icon: typeof Image; label: string } {
  const entry = sectionInfo[item.kind as ModpackContentSection]
  return { Icon: entry?.icon ?? FileJson, label: entry?.label ?? '任务文件' }
}

/** Reuse the text editor and resource image viewer in the content workspace. */
function ContentPreview({ projectPath, item, darkMode, revision, mod, editorRef }: { projectPath: string; item: ModpackContentItem; darkMode: boolean; revision: number; mod?: ModConfigIdentity; editorRef: MutableRefObject<ContentEditorHandle | null> }): React.JSX.Element {
  const [content, setContent] = useState<{ path: string; text?: string; image?: string; error?: string } | null>(null)
  const image = !item.directory && /\.(png|jpe?g|webp|gif|bmp)$/i.test(item.path)
  const text = isEditableContent(item)
  const oversized = Boolean(item.size && item.size > (image ? 20 : 2) * 1024 * 1024)
  useEffect(() => {
    let current = true
    setContent(null)
    if ((!text && !image) || oversized) return
    void (async () => {
      const path = await window.modmind.modpack.contentProjectPath(item.path)
      if (!current) return
      const value = image ? { image: await window.modmind.project.readImageAsset(path) } : { text: await window.modmind.project.readFile(path, projectPath) }
      if (current) setContent({ path, ...value })
    })().catch(error => { if (current) setContent({ path: item.path, error: error instanceof Error ? error.message : String(error) }) })
    return () => { current = false }
  }, [projectPath, item.path, item.size, image, text, oversized, revision])
  const ItemIcon = item.directory ? FolderOpen : contentVisual(item).Icon
  return <>
    <div className="pack-content-file-info"><span>{item.directory ? '目录' : item.path.split('.').at(-1)?.toUpperCase() ?? '文件'}</span><span>{scopeLabel(item.scope)}</span><span>{formatBytes(item.size)}</span>{mod ? <span title={`模组 ID：${mod.id}；依据文件名或目录名匹配`}>{mod.name} · 名称匹配</span> : null}</div>
    {(text || image) && !oversized && !content ? <div className="resource-pack-empty" role="status"><LoaderCircle className="spin" size={22} />正在读取文件…</div>
      : content?.text !== undefined ? <ContentTextEditor projectPath={projectPath} path={content.path} text={content.text} darkMode={darkMode} editorRef={editorRef} />
      : content?.image ? <ResourceImagePreview src={content.image} name={item.path} />
      : <div className="resource-pack-empty"><ItemIcon size={30} /><p>{content?.error ? '暂时无法预览此文件' : item.directory ? '目录内容' : oversized ? '文件超过预览大小限制' : '此文件使用专用格式'}</p><small>{content?.error || (item.directory ? '使用上方「在文件管理器中显示」查看目录。' : '可以查看文件位置和来源，或使用对应工具打开。')}</small>{item.sourceUrl ? <div className="pack-content-source-url"><span>下载来源</span><span>{item.sourceUrl}</span></div> : null}</div>}
  </>
}
