import { Suspense, useEffect, useState } from 'react'
import { FileCode2, RefreshCw, Save, Search, Undo2 } from 'lucide-react'
import MonacoCodeEditor from '../../../src/renderer/src/components/MonacoCodeEditor'
import { useConfirmDialog } from '../../../src/renderer/src/components/InteractionDialogs'
import type { FeaturePageContext } from '../../sdk/renderer'
import type { ShaderDocument, ShaderInventory } from '../../../src/shared/shaderStudio'
import ShaderFrame, { useShaderFeature } from '../../shader-shared/components/ShaderFrame'

export default function ShaderSources(context: FeaturePageContext): React.JSX.Element {
  const feature = useShaderFeature(context, 'shader-source'), { invoke, run, locked, setNotice } = feature
  const [inventory, setInventory] = useState<ShaderInventory>(), [document, setDocument] = useState<ShaderDocument>(), [text, setText] = useState('')
  const [query, setQuery] = useState(''), { confirm, dialog } = useConfirmDialog()
  const dirty = Boolean(document && text !== document.content)
  const readInventory = async () => setInventory(await invoke<ShaderInventory>('query', { operation: 'inventory' }))
  useEffect(() => { if (context.visible) void run('loading', readInventory) }, [context.visible, invoke])
  const reload = () => run('refresh', readInventory)
  const selectFile = (file: string) => run('read', async () => {
    if (dirty && !await confirm({ title: '放弃当前文件的未保存修改？', message: document!.path, confirmLabel: '放弃修改', tone: 'danger' })) return
    const next = await invoke<ShaderDocument>('query', { operation: 'read', path: file })
    setDocument(next); setText(next.content)
  })
  const save = () => run('save', async () => {
    if (!document) return
    setDocument(await invoke<ShaderDocument>('edit', { operation: 'save', path: document.path, content: text, revision: document.revision }))
    await readInventory(); context.filesChanged(); setNotice('文件已保存')
  })
  return <ShaderFrame context={context} view="source" feature={feature} dirty={dirty} refresh={() => void reload()} actions={<>
    <button className="icon-button" title="撤销上次保存" disabled={locked} onClick={() => void run('undo', async () => {
      if (dirty && !await confirm({ title: '放弃草稿并撤销上次保存？', message: '未保存编辑会丢弃；文件有后续修改时不会覆盖。', confirmLabel: '撤销保存' })) return
      setInventory(await invoke<ShaderInventory>('edit', { operation: 'undo' }))
      if (document) { const next = await invoke<ShaderDocument>('query', { operation: 'read', path: document.path }); setDocument(next); setText(next.content) }
      context.filesChanged(); setNotice('上次保存已撤销')
    })}><Undo2 size={16} /></button>
    <button className="primary-button compact" disabled={locked || !dirty} onClick={() => void save()}><Save size={15} />保存</button>
  </>}>
    <div className="shader-source-layout"><aside className="shader-files"><label className="shader-search"><Search size={14} /><input aria-label="搜索光影文件" placeholder="搜索文件" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="shader-file-list">{inventory?.files.filter(file => file.path.toLowerCase().includes(query.toLowerCase())).map(file => <button key={file.path} className={document?.path === file.path ? 'active' : ''} disabled={locked} title={file.path} onClick={() => !file.path.startsWith('shaders/') || file.kind === 'image' || file.kind === 'binary' ? context.openFile(file.path) : void selectFile(file.path)}><FileCode2 size={14} /><span>{file.path.replace(/^shaders\//, '')}</span></button>)}</div>
    </aside><div className="shader-editor">{document ? <><div className="shader-file-heading"><code>{document.path}</code><button className="icon-button" title="重新读取文件" disabled={locked} onClick={() => void selectFile(document.path)}><RefreshCw size={14} /></button></div><Suspense fallback={<div className="shader-empty">正在加载编辑器</div>}><MonacoCodeEditor path={`${context.project?.path}/${document.path}`} language={/\.(vsh|fsh|gsh|csh|glsl)$/.test(document.path) ? 'cpp' : 'plaintext'} value={text} darkMode={context.darkMode} readOnly={locked} onChange={setText} onSave={() => void save()} /></Suspense></> : <div className="shader-empty"><FileCode2 size={26} /><span>{feature.busy ? '正在读取工程' : '选择一个文件'}</span><button className="secondary-button compact" onClick={() => context.openFile()}>打开项目编辑器</button></div>}</div></div>
    {dialog}
  </ShaderFrame>
}
