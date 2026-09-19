import MoreActions from './MoreActions'
import { describeClientFailure } from '../../../shared/clientFailure'
import { reportClientFailure } from '../lib/clientFailure'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Box, Music2, Type, Languages, CheckCheck, Download, FilePlus2, FolderOpen, Image, LoaderCircle, Paintbrush, Play, Plus, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react'
import type { ProjectInfo } from '../../../shared/types'
import { resourceCategory, suggestedResourcePackFormat, type ResourceCategory, type ResourceImageTarget, type ResourcePackInfo, type ResourcePackValidation } from '../../../shared/resourcePack'
import MonacoCodeEditor from './MonacoCodeEditor'
import MiniPaintEditor from './MiniPaintEditor'
import { useConfirmDialog, usePromptDialog } from './InteractionDialogs'
import ResourceImagePreview from './ResourceImagePreview'
import ResourceThumbnail from './ResourceThumbnail'
import '../resource-packs.css'

const ResourceModelPreview = lazy(() => import('./ResourceModelPreview'))
const categories: Array<[ResourceCategory, string]> = [['all', '全部资源'], ['image', '贴图'], ['model', '模型'], ['audio', '音频'], ['language', '语言'], ['font', '字体'], ['other', '其他配置']]
const categoryIcons = { image: Image, model: Box, audio: Music2, language: Languages, font: Type, other: FilePlus2 }

export default function ResourcePackWorkspace({ project, darkMode, onImages, onModels, onTest, initialSelection }: { project: ProjectInfo; darkMode: boolean; onImages: (target?: ResourceImageTarget) => void; onModels: (target?: import('../../../shared/modelSource').ResourceModelTarget) => void; onTest: () => void; initialSelection?: { id: string; file: string } }): React.JSX.Element {
  const [packs, setPacks] = useState<ResourcePackInfo[]>([])
  const [id, setId] = useState('')
  const [file, setFile] = useState('')
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [image, setImage] = useState('')
  const [baseline, setBaseline] = useState('')
  const [fileReadOnly, setFileReadOnly] = useState(false)
  const [unsupported, setUnsupported] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [painting, setPainting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [validation, setValidation] = useState<ResourcePackValidation | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [format, setFormat] = useState<number | ''>(suggestedResourcePackFormat(project.minecraftVersion) ?? '')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ResourceCategory>('all')
  const [modelSource, setModelSource] = useState(false)
  const [previewRevision, setPreviewRevision] = useState(0)
  const loadToken = useRef(0)
  const { confirm, dialog } = useConfirmDialog()
  const { prompt, dialog: promptDialog } = usePromptDialog()
  const pack = packs.find(item => item.id === id)
  const packReadOnly = Boolean(pack?.readOnly || pack?.error)
  const readOnly = packReadOnly || fileReadOnly
  const dirty = !readOnly && text !== savedText
  const canPreviewModel = /^assets\/[^/]+\/models\/.+\.json$/.test(file)
  const openImages = async (): Promise<void> => { if (await canLeave()) onImages(image.startsWith('data:image/') ? { projectPath: project.path, id, file, baseline, dataUrl: image } : undefined) }
  const refresh = async (select?: string): Promise<void> => {
    const items = await window.modmind.resourcePacks.list(project.path)
    setPacks(items); setPreviewRevision(value => value + 1)
    const next = select ?? (items.some(item => item.id === id) ? id : items[0]?.id ?? '')
    setId(next)
    if (next !== id || !items.find(item => item.id === next)?.files.some(item => item.path === file)) {
      loadToken.current++; setFile(''); setFileReadOnly(false); setUnsupported(''); setFileSize(0); setText(''); setSavedText(''); setImage(''); setBaseline(''); setPainting(false); setModelSource(false); setValidation(null)
      if (next !== id) { setCategory('all'); setQuery('') }
    }
  }
  useEffect(() => {
    let active = true
    void (async () => {
      const items = await window.modmind.resourcePacks.list(project.path)
      if (!active) return
      setPacks(items)
      const selected = items.find(item => item.id === initialSelection?.id) ?? items[0]
      setId(selected?.id ?? '')
      if (selected && initialSelection && selected.files.some(item => item.path === initialSelection.file)) {
        const value = await window.modmind.resourcePacks.read(project.path, selected.id, initialSelection.file)
        if (!active) return
        setFile(initialSelection.file); setText(value.text ?? ''); setSavedText(value.text ?? ''); setImage(value.dataUrl ?? ''); setBaseline(value.baseline); setFileReadOnly(Boolean(value.readOnly)); setUnsupported(value.unsupported ?? ''); setFileSize(value.size ?? 0)
      }
    })().catch(error => { if (active) setNotice(reportClientFailure(error)) })
    return () => { active = false; loadToken.current++ }
  }, [project.path, initialSelection?.id, initialSelection?.file])
  const run = async (action: () => Promise<void>): Promise<void> => { if (busy) return; setBusy(true); setNotice(''); try { await action() } catch (error) { setNotice(reportClientFailure(error)) } finally { setBusy(false) } }
  const canLeave = (): Promise<boolean> => dirty || painting ? confirm({ title: '离开当前编辑', message: '尚未保存的修改将丢失。', confirmLabel: '离开', tone: 'danger' }) : Promise.resolve(true)
  const openFile = async (next: string): Promise<void> => {
    if (!await canLeave()) return
    const token = ++loadToken.current
    setPainting(false); setModelSource(false)
    await run(async () => { const value = await window.modmind.resourcePacks.read(project.path, id, next); if (token !== loadToken.current) return; setFile(next); setText(value.text ?? ''); setSavedText(value.text ?? ''); setImage(value.dataUrl ?? ''); setBaseline(value.baseline); setFileReadOnly(Boolean(value.readOnly)); setUnsupported(value.unsupported ?? ''); setFileSize(value.size ?? 0) })
  }
  const save = async (content = text): Promise<void> => {
    if (readOnly) throw new Error('请先创建可编辑副本')
    const next = await window.modmind.resourcePacks.write(project.path, id, file, content, baseline)
    setPacks(previous => previous.map(item => item.id === next.id ? next : item))
    const value = await window.modmind.resourcePacks.read(project.path, id, file)
    setBaseline(value.baseline); setFileReadOnly(Boolean(value.readOnly)); setUnsupported(value.unsupported ?? ''); setFileSize(value.size ?? 0); setText(value.text ?? ''); setSavedText(value.text ?? ''); setImage(value.dataUrl ?? ''); setValidation(null); setPreviewRevision(value => value + 1); setNotice('已保存')
  }
  const selectPack = async (next: string): Promise<void> => { if (await canLeave()) { loadToken.current++; setId(next); setFile(''); setFileReadOnly(false); setUnsupported(''); setFileSize(0); setText(''); setSavedText(''); setImage(''); setPainting(false); setModelSource(false); setValidation(null); setQuery(''); setCategory('all') } }
  return <div className="resource-pack-workspace"><h1 className="visually-hidden">资源包</h1>
    <div className="resource-pack-toolbar"><label>当前资源包<select aria-label="当前资源包" value={id} disabled={busy} onChange={event => void selectPack(event.target.value)}><option value="" disabled>选择资源包</option>{packs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>{pack?.files.length ?? 0} 个文件</span>{pack?.origin ? <span className="resource-pack-origin" title={pack.path}>{pack.origin === 'project' ? '项目资源 · 原位编辑' : pack.readOnly ? '整合包内 ZIP · 只读预览' : '整合包内目录 · 原位编辑'}</span> : null}{pack?.origin === 'installed' && pack.readOnly && !pack.error ? <button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const copy = await window.modmind.resourcePacks.makeEditable(project.path, id); await refresh(copy.id); setNotice('已创建可编辑副本，原 ZIP 保留在整合包中') })}>创建可编辑副本</button> : null}<div className="resource-pack-actions"><MoreActions label="资源包管理" text="管理"><button className="icon-button" title="刷新资源包" disabled={busy} onClick={() => void run(() => refresh())}><RefreshCw size={16} /></button><button className="secondary-button" disabled={busy} onClick={() => setCreating(true)}><Plus size={15} />新建</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const value = await window.modmind.resourcePacks.import(project.path); if (value) await refresh(value.id) })}><Upload size={15} />导入 ZIP</button><button className="icon-button" title="导入资源包目录" disabled={busy} onClick={() => void run(async () => { const value = await window.modmind.resourcePacks.import(project.path, true); if (value) await refresh(value.id) })}><FolderOpen size={17} /></button></MoreActions><button className="icon-button" title="在图像工坊中打开当前图片" disabled={busy || readOnly} onClick={() => void openImages()}><Paintbrush size={16} /></button><button className="secondary-button" disabled={busy || readOnly} onClick={() => void (async () => { if (!await canLeave()) return; if (resourceCategory(file) !== 'model') { onModels(); return }; await run(async () => { const target = await window.modmind.resourcePacks.openModel(project.path, id, file); onModels(target) }) })()}>模型</button><button className="secondary-button" disabled={busy || !pack || Boolean(pack.error)} onClick={() => void run(async () => { setValidation(await window.modmind.resourcePacks.validate(project.path, id)) })}><CheckCheck size={15} />校验</button><button className="secondary-button" disabled={busy || !pack || Boolean(pack.origin) || dirty || painting} onClick={() => void run(async () => { const result = await window.modmind.resourcePacks.deploy(project.path, id); setNotice(`${result.message}：${result.path}`) })}><Play size={15} />部署测试</button><button className="primary-button" disabled={busy || !pack || Boolean(pack.error) || pack.origin === 'project' || dirty || painting} onClick={() => void run(async () => { const target = await window.modmind.resourcePacks.export(project.path, id); if (target) setNotice(`已导出：${target}`) })}><Download size={15} />导出 ZIP</button></div></div>
    {pack?.error ? <div className="resource-pack-notice" role="alert">无法读取 {pack.name}：{describeClientFailure(pack.error)}</div> : null}
    <div className="resource-pack-body"><aside className="resource-pack-files"><label className="resource-pack-category"><span>类型</span><select aria-label="资源类型" value={category} onChange={event => setCategory(event.target.value as ResourceCategory)}>{categories.map(([value, label]) => <option key={value} value={value}>{label} · {pack?.files.filter(item => value === 'all' || resourceCategory(item.path) === value).length ?? 0}</option>)}</select></label><div className="resource-pack-file-tools"><input aria-label="筛选资源文件" value={query} onChange={event => setQuery(event.target.value)} placeholder="筛选文件" /><button className="icon-button" title="新建资源文件" disabled={!pack || busy || packReadOnly} onClick={() => void (async () => { const next = await prompt({ title: '新建资源文件', inputLabel: '包内相对路径', value: `assets/${project.namespace}/lang/zh_cn.json` }); if (!next) return; await run(async () => { await window.modmind.resourcePacks.write(project.path, id, next, next.endsWith('.json') ? '{}\n' : '', null); await refresh() }) })()}><FilePlus2 size={16} /></button><button className="icon-button" title="导入素材" disabled={!pack || busy || packReadOnly} onClick={() => void (async () => { const directory = await prompt({ title: '导入素材', inputLabel: '目标目录', value: `assets/${project.namespace}/textures/item` }); if (directory) await run(async () => { await window.modmind.resourcePacks.importAssets(project.path, id, directory); await refresh() }) })()}><Upload size={16} /></button></div>{pack?.files.filter(item => (category === 'all' || resourceCategory(item.path) === category) && item.path.toLowerCase().includes(query.toLowerCase())).map(item => { const Icon = categoryIcons[resourceCategory(item.path)]; return <button key={item.path} className={`resource-pack-file${file === item.path ? ' active' : ''}`} disabled={busy} title={item.path} onClick={() => void openFile(item.path)}>{item.kind === 'image' ? <ResourceThumbnail projectPath={project.path} id={id} file={item.path} revision={previewRevision} /> : <Icon size={14} />}<span>{item.path}</span></button> })}</aside>
      <section className="resource-pack-editor"><div className="resource-pack-editor-heading"><span>{file || pack?.description || '选择资源文件'}</span>{file ? <div className="resource-pack-actions">{canPreviewModel ? <button className="secondary-button" onClick={() => setModelSource(value => !value)}>{modelSource ? '模型预览' : '源码'}</button> : null}{!readOnly && image.startsWith('data:image/') ? <button className="secondary-button" disabled={busy} onClick={() => void (async () => { if (!painting || await canLeave()) setPainting(value => !value) })()}><Paintbrush size={15} />{painting ? '预览' : '编辑图像'}</button> : null}<button className="icon-button" title="删除文件" disabled={busy || readOnly || file === 'pack.mcmeta'} onClick={() => void (async () => { if (await confirm({ title: '删除资源文件', message: file, confirmLabel: '删除', tone: 'danger' })) await run(async () => { await window.modmind.resourcePacks.removeFile(project.path, id, file, baseline); setFile(''); setFileReadOnly(false); setUnsupported(''); setFileSize(0); setImage(''); setText(''); setSavedText(''); await refresh() }) })()}><Trash2 size={15} /></button>{!image ? <button className="icon-button" title="保存文件" disabled={busy || readOnly || !dirty} onClick={() => void run(() => save())}><Save size={16} /></button> : null}</div> : null}</div>
      {unsupported ? <div className="resource-pack-empty" role="status"><FilePlus2 size={28} /><p>{unsupported}</p><small>{file} · {fileSize.toLocaleString()} 字节</small></div> : painting && image.startsWith('data:image/') ? <MiniPaintEditor key={`${id}:${file}`} asset={{ id: `${id}:${file}`, dataUrl: image, createdAt: '', model: 'resource-pack', style: 'minecraft', size: '', quality: 'auto', hosted: false, credits: 0 }} darkMode={darkMode} onError={setNotice} onSave={async value => { if (busy) throw new Error('请等待当前操作完成'); await save(value) }} /> : image.startsWith('data:image/') ? <ResourceImagePreview key={`${id}:${file}:${baseline}`} src={image} name={file} /> : image.startsWith('data:audio/') ? <div className="resource-pack-audio"><Music2 size={28} /><span>{file.split('/').at(-1)}</span><audio key={file} controls src={image} /></div> : canPreviewModel && !modelSource && !dirty ? <Suspense fallback={<div className="resource-pack-empty">加载预览…</div>}><ResourceModelPreview projectPath={project.path} packId={id} file={file} revision={`${baseline}:${previewRevision}`} onOpenFile={next => void openFile(next)} /></Suspense> : file ? <MonacoCodeEditor readOnly={readOnly} path={`${project.path}/${pack?.path}/${file}`} language={/\.(json|mcmeta)$/i.test(file) ? 'json' : 'plaintext'} value={text} darkMode={darkMode} onChange={setText} onSave={() => void run(() => save())} /> : <div className="resource-pack-empty"><FolderOpen size={28} /><p>{pack ? '选择文件' : '暂无资源包'}</p><button className="secondary-button" onClick={onTest}><Play size={15} />游戏测试</button></div>}</section></div>
    {validation ? <section className="resource-pack-validation"><strong>{validation.success ? '结构校验通过' : '校验未通过'} · {validation.checked} 个文件</strong>{validation.issues.map((issue, index) => <button key={index} onClick={() => void openFile(issue.path)}><span>{issue.severity === 'error' ? '错误' : '提示'}</span> {issue.path}：{issue.message}</button>)}<small>实际显示效果需要在客户端加载后验证</small></section> : null}
    {notice || busy ? <div className="resource-pack-notice" role="status">{busy ? <LoaderCircle className="spin" size={15} /> : null}{notice || '处理中…'}</div> : null}
    {creating ? <div className="modal-backdrop"><form className="dialog" role="dialog" aria-modal="true" aria-label="新建资源包" onSubmit={event => { event.preventDefault(); void run(async () => { const value = await window.modmind.resourcePacks.create(project.path, { name, description, packFormat: Number(format) }); setCreating(false); await refresh(value.id) }) }}><div className="dialog-header"><h2>新建资源包</h2><button className="icon-button" title="关闭" type="button" onClick={() => setCreating(false)}><X size={16} /></button></div><label className="field-label">名称<input required value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label className="field-label">描述<input value={description} maxLength={4000} onChange={event => setDescription(event.target.value)} /></label><label className="field-label">资源包格式版本<input required type="number" min={1} max={10000} value={format} onChange={event => setFormat(event.target.value ? Number(event.target.value) : '')} /></label><div className="dialog-footer"><button className="primary-button" disabled={busy || !name.trim() || !format}><Plus size={15} />创建</button></div></form></div> : null}{dialog}{promptDialog}
  </div>
}
