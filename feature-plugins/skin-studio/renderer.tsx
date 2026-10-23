import { useCallback, useEffect, useRef, useState } from 'react'
import { Brush, Check, Download, Eraser, Eye, FileImage, LoaderCircle, Palette, Plus, RotateCcw, Save, ShieldCheck, Upload, X } from 'lucide-react'
import { anyProject, registerFeature, type FeaturePageContext } from '../sdk/renderer'
import './skin-studio.css'

type Model = 'slim' | 'classic'
type Tool = 'pencil' | 'eraser' | 'picker'
type SkinRecord = { name: string; model: Model; path: string; updatedAt?: string }
type Validation = { passed: boolean; model?: Model; basePixels?: number; outerPixels?: number; errors: Array<{ code: string; xy?: [number, number]; rgba?: number[] }> ; gameRuntimeVerified?: boolean }
type SkinRead = { name: string; model: Model; path: string; dataUrl: string; validation?: Validation }

const DEFAULT_PALETTE = ['#1f2937', '#5b3a29', '#9b5c35', '#d8905c', '#f1c7a4', '#f4e7d3', '#e8b44f', '#5ca7d7', '#4c8b5b', '#b64956', '#ffffff', '#111827']
const FACE = {
  head: { front: [8, 8, 8, 8], back: [24, 8, 8, 8], right: [0, 8, 8, 8], left: [16, 8, 8, 8], frontOuter: [40, 8, 8, 8], backOuter: [56, 8, 8, 8] },
  body: { front: [20, 20, 8, 12], back: [32, 20, 8, 12], right: [16, 20, 4, 12], left: [28, 20, 4, 12], frontOuter: [20, 20, 8, 12], backOuter: [32, 20, 8, 12] },
  rightArm: { front: [44, 20, 4, 12], back: [52, 20, 4, 12], right: [40, 20, 4, 12], left: [48, 20, 4, 12], frontOuter: [44, 36, 4, 12], backOuter: [52, 36, 4, 12] },
  leftArm: { front: [36, 52, 4, 12], back: [48, 52, 4, 12], right: [32, 52, 4, 12], left: [40, 52, 4, 12], frontOuter: [36, 36, 4, 12], backOuter: [48, 36, 4, 12] },
  rightLeg: { front: [4, 20, 4, 12], back: [12, 20, 4, 12], right: [0, 20, 4, 12], left: [8, 20, 4, 12], frontOuter: [4, 36, 4, 12], backOuter: [12, 36, 4, 12] },
  leftLeg: { front: [20, 52, 4, 12], back: [28, 52, 4, 12], right: [16, 52, 4, 12], left: [24, 52, 4, 12], frontOuter: [20, 36, 4, 12], backOuter: [28, 36, 4, 12] }
} as const

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function dataUrlFromCanvas(canvas: HTMLCanvasElement): string { return canvas.toDataURL('image/png') }
function blankSkin(canvas: HTMLCanvasElement, model: Model): void {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 64, 64)
  ctx.fillStyle = '#f1c7a4'
  const arm = model === 'slim' ? 3 : 4
  const parts: Array<[number, number, number, number, number]> = [[0, 0, 8, 8, 8], [16, 16, 8, 4, 12], [40, 16, arm, 4, 12], [32, 48, arm, 4, 12], [0, 16, 4, 4, 12], [16, 48, 4, 4, 12]]
  for (const [x, y, w, d, h] of parts) {
    const boxes = [[x + d, y, w, d], [x + d + w, y, w, d], [x, y + d, d, h], [x + d, y + d, w, h], [x + d + w, y + d, d, h], [x + 2 * d + w, y + d, w, h]]
    for (const [bx, by, bw, bh] of boxes) ctx.fillRect(bx, by, bw, bh)
  }
}
function PixelEditor({ canvasRef, revision, onRevision, selectedColor, tool, onPick }: { canvasRef: React.RefObject<HTMLCanvasElement>; revision: number; onRevision: () => void; selectedColor: string; tool: Tool; onPick: (color: string) => void }): React.JSX.Element {
  const painting = useRef(false)
  const paint = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(63, Math.floor((event.clientX - rect.left) / rect.width * 64)))
    const y = Math.max(0, Math.min(63, Math.floor((event.clientY - rect.top) / rect.height * 64)))
    const ctx = canvas.getContext('2d')!
    if (tool === 'picker') {
      const value = ctx.getImageData(x, y, 1, 1).data
      if (value[3] > 0) onPick(`#${[value[0], value[1], value[2]].map(component => component.toString(16).padStart(2, '0')).join('')}`)
      return
    }
    ctx.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,0)' : selectedColor
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.fillRect(x, y, 1, 1)
    ctx.globalCompositeOperation = 'source-over'
    onRevision()
  }
  return <div className="skin-editor-canvas-wrap"><canvas ref={canvasRef} width={64} height={64} aria-label="64×64 皮肤像素画布" className="skin-editor-canvas" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); painting.current = true; paint(event) }} onPointerMove={event => { if (painting.current) paint(event) }} onPointerUp={() => { painting.current = false }} onPointerCancel={() => { painting.current = false }} data-revision={revision} /></div>
}

function SkinFigure({ canvasRef, model, view, revision }: { canvasRef: React.RefObject<HTMLCanvasElement>; model: Model; view: 'front' | 'back' | 'side'; revision: number }): React.JSX.Element {
  const previewRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const source = canvasRef.current, target = previewRef.current
    if (!source || !target) return
    const ctx = target.getContext('2d')!
    const scale = 12
    target.width = 20 * scale; target.height = 28 * scale
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.imageSmoothingEnabled = false
    const side = view === 'front' ? 'front' : view === 'back' ? 'back' : 'right'
    const draw = (part: keyof typeof FACE, x: number, y: number, outer = false): void => {
      const box = FACE[part][outer ? `${side}Outer` as keyof typeof FACE[typeof part] : side as keyof typeof FACE[typeof part]] as readonly number[] | undefined
      if (!box) return
      const [sx, sy, rawWidth, sh] = box
      const sw = (part === 'rightArm' || part === 'leftArm') && (side === 'front' || side === 'back') ? (model === 'slim' ? 3 : 4) : rawWidth
      ctx.drawImage(source, sx, sy, sw, sh, x * scale, y * scale, sw * scale, sh * scale)
    }
    draw('head', 6, 0); draw('head', 6, 0, true)
    draw('body', 6, 8); draw('body', 6, 8, true)
    draw('rightArm', 2, 8); draw('rightArm', 2, 8, true)
    draw('leftArm', 14, 8); draw('leftArm', 14, 8, true)
    draw('rightLeg', 6, 20); draw('rightLeg', 6, 20, true)
    draw('leftLeg', 10, 20); draw('leftLeg', 10, 20, true)
  }, [canvasRef, model, view, revision])
  return <canvas ref={previewRef} className="skin-figure-canvas" aria-label={`${view === 'front' ? '正面' : view === 'back' ? '背面' : '侧面'}皮肤预览`} />
}

function SkinStudio({ context }: { context: FeaturePageContext }): React.JSX.Element | null {
  const project = context.project
  const editorRef = useRef<HTMLCanvasElement>(null)
  const projectRef = useRef(project?.path)
  const [model, setModel] = useState<Model>('slim')
  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState(DEFAULT_PALETTE[0])
  const palette = DEFAULT_PALETTE
  const [name, setName] = useState('我的皮肤')
  const [revision, setRevision] = useState(0)
  const [skins, setSkins] = useState<SkinRecord[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [validation, setValidation] = useState<Validation | null>(null)
  const [view, setView] = useState<'front' | 'back' | 'side'>('front')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  projectRef.current = project?.path

  const invoke = useCallback(async <T,>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
    if (!project) throw new Error('请先打开一个 Minecraft 项目')
    const projectPath = project.path
    const result = await window.modmind.featurePlugins.invoke('skin-studio', action, { ...input, projectPath }) as T
    if (projectRef.current !== projectPath) throw new Error('项目已切换，请刷新当前皮肤工作区')
    return result
  }, [project])
  const refresh = useCallback(async (): Promise<void> => {
    if (!project) return
    setBusy('loading'); setError('')
    try {
      const result = await invoke<{ skins: SkinRecord[] }>('query', { operation: 'list' })
      setSkins(result.skins)
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }, [invoke, project])
  useEffect(() => {
    if (!project) return
    const canvas = editorRef.current
    if (canvas) { blankSkin(canvas, model); setRevision(value => value + 1) }
    setSelectedPath(''); setValidation(null); setName('我的皮肤'); setNotice('')
    void refresh()
  }, [project?.path])
  useEffect(() => {
    const canvas = editorRef.current
    if (!canvas || revision !== 0) return
    blankSkin(canvas, model)
  }, [model])
  const read = async (skin: SkinRecord): Promise<void> => {
    setBusy('loading'); setError(''); setNotice('')
    try {
      const value = await invoke<SkinRead>('query', { operation: 'read', path: skin.path })
      const image = new Image()
      image.onload = () => { const canvas = editorRef.current!; canvas.getContext('2d')!.clearRect(0, 0, 64, 64); canvas.getContext('2d')!.drawImage(image, 0, 0); setRevision(current => current + 1) }
      image.src = value.dataUrl
      setModel(value.model); setName(value.name); setSelectedPath(value.path); setValidation(value.validation ?? null)
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const importPng = (file: File): void => {
    setError(''); setNotice('')
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth !== 64 || image.naturalHeight !== 64) { setError('Minecraft 皮肤必须是 64×64 PNG，未缩放导入'); return }
      const canvas = editorRef.current!
      const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, 64, 64); ctx.drawImage(image, 0, 0)
      setSelectedPath(''); setRevision(value => value + 1); setNotice(`已载入 ${file.name}`)
    }
    image.onerror = () => setError('无法读取 PNG 图片')
    image.src = URL.createObjectURL(file)
  }
  const dataUrl = (): string => editorRef.current ? dataUrlFromCanvas(editorRef.current) : ''
  const validate = async (): Promise<Validation | null> => {
    setBusy('validate'); setError('')
    try { const value = await invoke<Validation>('query', { operation: 'validate', dataUrl: dataUrl(), model }); setValidation(value); return value }
    catch (reason) { setError(messageOf(reason)); return null } finally { setBusy('') }
  }
  const save = async (): Promise<void> => {
    if (!name.trim()) { setError('请填写皮肤名称'); return }
    setBusy('save'); setError(''); setNotice('')
    try {
      const value = await invoke<{ path: string; validation: Validation }>('manage', { operation: 'save', name: name.trim(), model, dataUrl: dataUrl(), previousPath: selectedPath || undefined })
      setSelectedPath(value.path); setValidation(value.validation); setNotice(`已保存 ${value.path}`); await refresh(); context.filesChanged()
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  const exportPng = async (): Promise<void> => {
    setBusy('export'); setError('')
    try { const value = await invoke<{ path: string }>('manage', { operation: 'export', name: name.trim() || 'minecraft-skin', model, dataUrl: dataUrl() }); setNotice(`已导出 ${value.path}`) }
    catch (reason) { setError(messageOf(reason)) } finally { setBusy('') }
  }
  if (!project) return null
  const validationLabel = !validation ? '尚未检查' : validation.passed ? '像素检查通过' : `有 ${validation.errors.length} 项问题`
  return <section className="skin-studio-page" data-project-path={project.path}>
    <header className="skin-studio-toolbar"><span className="skin-studio-object">{project.name} <span aria-hidden="true">·</span> Minecraft 皮肤</span><div className="skin-studio-toolbar-actions"><button className="secondary-button" type="button" onClick={() => void exportPng()} disabled={Boolean(busy)}><Download size={15} />导出 PNG</button><button className="primary-button" type="button" onClick={() => void save()} disabled={Boolean(busy)}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存皮肤</button></div></header>
    {error ? <div className="skin-studio-message error" role="alert"><X size={16} />{error}<button type="button" className="secondary-button compact" onClick={() => setError('')}>关闭</button></div> : null}
    {notice ? <div className="skin-studio-message" role="status"><Check size={16} />{notice}</div> : null}
    <div className="skin-studio-layout">
      <aside className="skin-studio-sidebar">
        <div className="skin-studio-section-heading"><strong>项目皮肤</strong><button type="button" className="icon-button" title="新建皮肤" aria-label="新建皮肤" onClick={() => { const canvas = editorRef.current!; blankSkin(canvas, model); setSelectedPath(''); setName('我的皮肤'); setValidation(null); setRevision(value => value + 1); setNotice('已新建空白皮肤') }}><Plus size={16} /></button></div>
        {skins.length ? skins.map(skin => <button type="button" key={skin.path} className={`skin-studio-row${selectedPath === skin.path ? ' active' : ''}`} onClick={() => void read(skin)} disabled={Boolean(busy)}><FileImage size={16} /><span><strong>{skin.name}</strong><small>{skin.model === 'slim' ? 'Slim 细臂' : 'Classic 普通手臂'}</small></span></button>) : <p className="skin-studio-empty">还没有保存的皮肤</p>}
        <div className="skin-studio-sidebar-actions"><label className="secondary-button compact"><Upload size={14} />导入 64×64 PNG<input type="file" accept="image/png" hidden onChange={event => { const file = event.target.files?.[0]; if (file) importPng(file); event.currentTarget.value = '' }} /></label><button type="button" className="secondary-button compact" onClick={() => void refresh()} disabled={Boolean(busy)}><RotateCcw size={14} />刷新列表</button></div>
      </aside>
      <main className="skin-studio-workspace">
        <div className="skin-studio-editor-head"><label>名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>手臂模型<select value={model} disabled={Boolean(busy)} onChange={event => { setModel(event.target.value as Model); setValidation(null) }}><option value="slim">Slim · 细臂</option><option value="classic">Classic · 普通手臂</option></select></label><span className={`skin-studio-validation ${validation?.passed ? 'passed' : validation ? 'failed' : ''}`}><ShieldCheck size={15} />{validationLabel}</span></div>
        <div className="skin-studio-content">
          <div className="skin-studio-paint-panel"><div className="skin-studio-panel-title"><span><Palette size={15} />像素画布</span><span>64×64 · 原生像素</span></div><PixelEditor canvasRef={editorRef} revision={revision} onRevision={() => { setValidation(null); setRevision(value => value + 1) }} selectedColor={color} tool={tool} onPick={value => { setColor(value); setTool('pencil') }} /><div className="skin-studio-tools"><button className={tool === 'pencil' ? 'active' : ''} type="button" title="画笔" aria-label="画笔" onClick={() => setTool('pencil')}><Brush size={16} /></button><button className={tool === 'eraser' ? 'active' : ''} type="button" title="橡皮擦" aria-label="橡皮擦" onClick={() => setTool('eraser')}><Eraser size={16} /></button><button className={tool === 'picker' ? 'active' : ''} type="button" title="取色" aria-label="取色" onClick={() => setTool('picker')}><Eye size={16} /></button><input aria-label="自定义颜色" type="color" value={color} onChange={event => { setColor(event.target.value); setTool('pencil') }} /><div className="skin-studio-palette">{palette.map(value => <button key={value} type="button" className={color === value ? 'selected' : ''} style={{ backgroundColor: value }} aria-label={`选择颜色 ${value}`} onClick={() => { setColor(value); setTool('pencil') }} />)}</div></div><div className="skin-studio-paint-actions"><button type="button" className="secondary-button compact" onClick={() => { const canvas = editorRef.current!; blankSkin(canvas, model); setValidation(null); setRevision(value => value + 1) }} disabled={Boolean(busy)}><RotateCcw size={14} />重置底稿</button><button type="button" className="secondary-button compact" onClick={() => void validate()} disabled={Boolean(busy)}>{busy === 'validate' ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}检查皮肤</button></div></div>
          <div className="skin-studio-preview-panel"><div className="skin-studio-panel-title"><span>角色预览</span><span>基础层与外层叠加</span></div><div className="skin-studio-view-tabs" role="tablist"><button type="button" role="tab" aria-selected={view === 'front'} onClick={() => setView('front')}>正面</button><button type="button" role="tab" aria-selected={view === 'side'} onClick={() => setView('side')}>侧面</button><button type="button" role="tab" aria-selected={view === 'back'} onClick={() => setView('back')}>背面</button></div><div className="skin-studio-figure-stage"><SkinFigure canvasRef={editorRef} model={model} view={view} revision={revision} /></div><div className="skin-studio-preview-note">预览按 Minecraft UV 展开图读取，最终效果仍需在游戏内检查。</div></div>
        </div>
        {validation && !validation.passed ? <div className="skin-studio-validation-details" role="alert"><strong>需要修正</strong><span>{validation.errors.slice(0, 5).map(error => `${error.code}${error.xy ? ` (${error.xy.join(', ')})` : ''}`).join('、')}{validation.errors.length > 5 ? ` 等 ${validation.errors.length} 项` : ''}</span></div> : null}
      </main>
    </div>
  </section>
}

function Page(context: FeaturePageContext): React.JSX.Element | null { return <SkinStudio context={context} /> }
registerFeature('skin-studio', { apiVersion: 2, pages: [{ id: 'skin-studio', label: '皮肤工坊', group: '资源', icon: Palette, order: 25, scope: 'project', supports: anyProject, component: Page }] })


