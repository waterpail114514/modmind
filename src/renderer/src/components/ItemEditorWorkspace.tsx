import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Hammer, Image, LoaderCircle, Package, Plus, RefreshCw, Save, Search, Trash2, Upload } from 'lucide-react'
import type { ItemEditorState, ManagedItem, ManagedItemKind, VanillaItem, VanillaItemKind } from '../../../shared/itemEditor'
import type { ProjectInfo } from '../../../shared/types'
import type { FtbQuestIconResult } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'
import MoreActions from './MoreActions'
import './item-editor.css'

const ModelCanvas = lazy(() => import('./ResourceModelPreview').then(module => ({ default: module.ModelCanvas })))

const blankItem: ManagedItem = { id: '', name: '', englishName: '', kind: 'item', stackSize: 64, durability: 0, texture: 'minecraft:item/iron_ingot' }
const kinds: Array<[ManagedItemKind, string]> = [['item', '普通物品'], ['sword', '剑'], ['pickaxe', '镐'], ['axe', '斧'], ['shovel', '锹'], ['hoe', '锄'], ['armor', '护甲']]
const vanillaKinds: Array<[VanillaItemKind, string]> = [...kinds, ['block', '方块']]
const tiers = [['wood', '木'], ['stone', '石'], ['iron', '铁'], ['gold', '金'], ['diamond', '钻石'], ['netherite', '下界合金']] as const
const armorMaterials = [['leather', '皮革'], ['chain', '锁链'], ['iron', '铁'], ['gold', '金'], ['diamond', '钻石'], ['netherite', '下界合金']] as const
const armorSlots = [['helmet', '头盔'], ['chestplate', '胸甲'], ['leggings', '护腿'], ['boots', '靴子']] as const

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ModelPreview = NonNullable<FtbQuestIconResult['modelPreview']>
type ItemPreview = { icon: string; model: ModelPreview | null; needsThumbnail: boolean }
type PreviewState = { key: string; data: ItemPreview | null; loading: boolean; failed: boolean }

export default function ItemEditorWorkspace({ project, onOpenImages, onBuild, onTest, onFilesChanged }: {
  project: ProjectInfo
  onOpenImages: () => void
  onBuild: () => void
  onTest: () => void
  onFilesChanged: () => void
}): React.JSX.Element {
  const [state, setState] = useState<ItemEditorState | null>(null)
  const [source, setSource] = useState<'project' | 'vanilla'>('project')
  const [vanillaItems, setVanillaItems] = useState<VanillaItem[] | null>(null)
  const [vanillaError, setVanillaError] = useState('')
  const [selectedVanillaId, setSelectedVanillaId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<VanillaItemKind | 'all'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ManagedItem>(blankItem)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>({ key: '', data: null, loading: false, failed: false })
  const [renderedModelKey, setRenderedModelKey] = useState('')
  const previewCache = useRef(new Map<string, ItemPreview>())
  const pendingPreviews = useRef(new Map<string, Promise<ItemPreview>>())
  const { confirm, dialog } = useConfirmDialog()
  const selected = state?.items.find(item => item.id === selectedId)
  const selectedVanilla = vanillaItems?.find(item => item.id === selectedVanillaId)
  const dirty = source === 'project' && JSON.stringify(draft) !== JSON.stringify(selected ?? blankItem)
  const valid = /^[a-z0-9_]{1,64}$/.test(draft.id)
    && draft.name.trim().length > 0 && draft.englishName.trim().length > 0
    && Number.isInteger(draft.stackSize) && draft.stackSize >= 1 && draft.stackSize <= 99
    && Number.isInteger(draft.durability) && draft.durability >= 0 && draft.durability <= 100000
    && (draft.durability === 0 || draft.stackSize === 1)
    && (draft.kind === 'item' || (draft.stackSize === 1 && draft.durability > 0))
    && (draft.kind === 'item' || draft.kind === 'armor' || (Boolean(draft.tier)
      && Number.isFinite(draft.attackDamage) && Number.isFinite(draft.attackSpeed)
      && draft.attackDamage! >= 0 && draft.attackDamage! <= 100 && draft.attackSpeed! >= -4 && draft.attackSpeed! <= 4))
    && (draft.kind !== 'armor' || (Boolean(draft.armorSlot) && Boolean(draft.armorMaterial)))
    && (draft.kind !== 'sword' || Number.isInteger(draft.attackDamage))
    && (project.minecraftVersion !== '1.20.1' || !['sword', 'pickaxe', 'hoe'].includes(draft.kind) || Number.isInteger(draft.attackDamage))
  const validationMessage = !dirty || valid ? ''
    : !/^[a-z0-9_]{1,64}$/.test(draft.id) ? '物品 ID 只能使用小写字母、数字和下划线'
      : !draft.name.trim() || !draft.englishName.trim() ? '请填写中文名称和英文名称'
        : !Number.isInteger(draft.stackSize) || draft.stackSize < 1 || draft.stackSize > 99 ? '堆叠数应为 1 至 99'
          : !Number.isInteger(draft.durability) || draft.durability < 0 || draft.durability > 100000 ? '耐久应为 0 至 100000'
            : draft.durability > 0 && draft.stackSize !== 1 ? '有耐久的物品只能堆叠 1 个'
              : '请检查当前类型的属性'

  const visibleProjectItems = useMemo(() => (state?.items ?? []).filter(item =>
    (kindFilter === 'all' || item.kind === kindFilter)
    && `${item.name} ${item.englishName} ${project.namespace}:${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())
  ), [state?.items, kindFilter, query, project.namespace])
  const visibleVanillaItems = useMemo(() => (vanillaItems ?? []).filter(item =>
    (kindFilter === 'all' || item.kind === kindFilter)
    && `${item.name} ${item.englishName} minecraft:${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())
  ), [vanillaItems, kindFilter, query])

  const textureOptions = useMemo(() => {
    const values = ['minecraft:item/iron_ingot', ...(state?.textures ?? [])]
    if (!values.includes(draft.texture)) values.push(draft.texture)
    return values
  }, [draft.texture, state?.textures])
  const previewTexture = source === 'vanilla' ? selectedVanillaId ? `minecraft:${selectedVanillaId}` : '' : draft.texture
  const previewKey = `${project.path}:${previewTexture}`
  const currentPreview = previewState.key === previewKey ? previewState : { key: previewKey, data: null, loading: Boolean(previewTexture), failed: false }
  const displayModel = currentPreview.data?.model ?? undefined
  const itemSprite = displayModel ? undefined : currentPreview.data?.icon || undefined

  const onModelRendered = useCallback((thumbnail?: string): void => {
    setRenderedModelKey(previewKey)
    if (!thumbnail) return
    const cached = previewCache.current.get(previewKey)
    if (!cached || cached.icon) return
    const updated = { ...cached, icon: thumbnail }
    previewCache.current.set(previewKey, updated)
    setPreviewState(current => current.key === previewKey ? { ...current, data: updated } : current)
  }, [previewKey])

  useEffect(() => {
    let active = true
    previewCache.current.clear()
    pendingPreviews.current.clear()
    setState(null)
    setSource('project')
    setVanillaItems(null)
    setVanillaError('')
    setSelectedVanillaId(null)
    setQuery('')
    setKindFilter('all')
    setSelectedId(null)
    setDraft(blankItem)
    setError('')
    void window.modmind.itemEditor.list(project.path).then(value => {
      if (!active) return
      setState(value)
      const first = value.items[0]
      if (first) { setSelectedId(first.id); setDraft(first) }
    }).catch(reason => { if (active) setError(errorText(reason)) })
    return () => { active = false }
  }, [project.path])

  useEffect(() => {
    if (source !== 'vanilla' || vanillaItems || vanillaError) return
    let active = true
    void window.modmind.itemEditor.catalog(project.path).then(items => {
      if (!active) return
      setVanillaItems(items)
      setSelectedVanillaId(current => current ?? items[0]?.id ?? null)
    }).catch(reason => { if (active) setVanillaError(errorText(reason)) })
    return () => { active = false }
  }, [source, vanillaItems, vanillaError, project.path])

  useEffect(() => {
    if (!previewTexture) { setPreviewState({ key: previewKey, data: null, loading: false, failed: false }); return }
    const cached = previewCache.current.get(previewKey)
    if (cached) {
      previewCache.current.delete(previewKey)
      previewCache.current.set(previewKey, cached)
      setPreviewState({ key: previewKey, data: cached, loading: false, failed: false })
      return
    }
    let active = true
    setPreviewState({ key: previewKey, data: null, loading: true, failed: false })
    let task = pendingPreviews.current.get(previewKey)
    if (!task) {
      const local = previewTexture.startsWith(`${project.namespace}:item/`)
      const name = previewTexture.split('/').at(-1)
      task = local
        ? window.modmind.project.readImageAsset(`src/main/resources/assets/${project.namespace}/textures/item/${name}.png`, project.path).then(icon => ({ icon, model: null, needsThumbnail: false }))
        : window.modmind.modpack.inspectFtbQuestIcon(previewTexture.replace(':item/', ':'), project.path, true).then(result => ({ icon: result.icon?.url ?? '', model: result.icon?.modelPreview ?? null, needsThumbnail: Boolean(result.icon?.modelPreview && !result.icon.url) }))
      pendingPreviews.current.set(previewKey, task)
      void task.then(value => {
        const cache = previewCache.current
        cache.delete(previewKey)
        cache.set(previewKey, value)
        if (cache.size > 48) cache.delete(cache.keys().next().value!)
      }).catch(() => undefined).finally(() => pendingPreviews.current.delete(previewKey))
    }
    void task.then(value => { if (active) setPreviewState({ key: previewKey, data: value, loading: false, failed: false }) })
      .catch(() => { if (active) setPreviewState({ key: previewKey, data: null, loading: false, failed: true }) })
    return () => { active = false }
  }, [previewKey, previewTexture, project.namespace, project.path])

  const canLeave = async (): Promise<boolean> => !dirty || confirm({ title: '放弃未保存的修改？', message: '当前物品的修改尚未保存。', confirmLabel: '放弃修改', tone: 'danger' })
  const select = async (item: ManagedItem | null): Promise<void> => {
    if (!await canLeave()) return
    setSelectedId(item?.id ?? null)
    setDraft(item ?? blankItem)
    setError('')
    setNotice('')
  }
  const changeSource = async (next: 'project' | 'vanilla'): Promise<void> => {
    if (next === source || !await canLeave()) return
    setDraft(selected ?? blankItem)
    setSource(next)
    setQuery('')
    setKindFilter('all')
    setError('')
    setNotice('')
  }
  const refresh = async (): Promise<void> => {
    if (!await canLeave()) return
    setBusy(true)
    setError('')
    try {
      previewCache.current.clear()
      const value = await window.modmind.itemEditor.list(project.path)
      setState(value)
      const item = value.items.find(entry => entry.id === selectedId) ?? value.items[0]
      setSelectedId(item?.id ?? null)
      setDraft(item ?? blankItem)
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const save = async (): Promise<void> => {
    if (!state || !valid || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const value = await window.modmind.itemEditor.save(project.path, { revision: state.revision, item: draft })
      setState(value)
      const item = value.items.find(entry => entry.id === draft.id)!
      setSelectedId(item.id)
      setDraft(item)
      setNotice('物品已保存')
      onFilesChanged()
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!state || !selectedId || busy) return
    if (!await confirm({ title: '删除物品？', message: `将移除 ${project.namespace}:${selectedId} 的注册、模型与语言条目。贴图文件会保留。`, confirmLabel: '删除物品', tone: 'danger' })) return
    setBusy(true)
    setError('')
    try {
      const value = await window.modmind.itemEditor.remove(project.path, selectedId, state.revision)
      setState(value)
      const first = value.items[0]
      setSelectedId(first?.id ?? null)
      setDraft(first ?? blankItem)
      setNotice('物品已删除。')
      onFilesChanged()
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const importTexture = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const texture = await window.modmind.itemEditor.importTexture(project.path)
      if (!texture) return
      previewCache.current.delete(`${project.path}:${texture}`)
      const value = await window.modmind.itemEditor.list(project.path)
      setState(value)
      setDraft(current => ({ ...current, texture }))
      onFilesChanged()
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const changeKind = (kind: ManagedItemKind): void => {
    setDraft(current => ({ ...current, kind,
      stackSize: kind === 'item' ? current.stackSize : 1,
      durability: kind === 'item' ? current.durability : current.durability || 250,
      ...(kind !== 'item' && kind !== 'armor' ? { tier: current.tier ?? 'iron', attackDamage: current.attackDamage ?? 3, attackSpeed: current.attackSpeed ?? -2.4 } : {}),
      ...(kind === 'armor' ? { armorSlot: current.armorSlot ?? 'helmet', armorMaterial: current.armorMaterial ?? 'iron' } : {})
    }))
  }

  return <section className="item-editor-page">
    <header className="item-editor-header">
      <h1 className="visually-hidden">物品与装备</h1>
      <span className="item-editor-context">{project.name} <span aria-hidden="true">·</span> Minecraft {project.minecraftVersion}</span>
      <div className="item-editor-actions">
        <button className="secondary-button" onClick={() => void canLeave().then(allowed => { if (allowed) onBuild() })}><Hammer size={16} />构建测试</button>
        <MoreActions label="物品与装备更多操作">
          <button type="button" onClick={() => void canLeave().then(allowed => { if (allowed) onOpenImages() })}><Image size={16} />图像工坊</button>
          <button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} />刷新物品</button>
        </MoreActions>
      </div>
    </header>
    {error ? <div className="item-editor-message error" role="alert">{error}</div> : null}
    {notice ? <div className="item-editor-message" role="status">{notice}{notice === '物品已保存' ? <button type="button" onClick={onTest}>进入游戏测试</button> : null}</div> : null}
    {!state ? <div className="item-editor-loading" role="status"><LoaderCircle className="spin" size={18} />载入物品…</div>
      : !state.supported ? <div className="item-editor-unavailable">{state.reason}</div>
        : <div className="item-editor-layout">
          <aside className="item-editor-list" aria-label="物品列表">
            <div className="item-editor-list-heading"><strong>物品 <span>{source === 'project' ? visibleProjectItems.length : visibleVanillaItems.length}</span></strong>{source === 'project' ? <button className="icon-button" type="button" title="新建物品" aria-label="新建物品" onClick={() => void select(null)} disabled={busy}><Plus size={16} /></button> : null}</div>
            <div className="item-editor-source-tabs" role="tablist" aria-label="物品来源">
              <button type="button" role="tab" aria-selected={source === 'project'} onClick={() => void changeSource('project')}>项目物品</button>
              <button type="button" role="tab" aria-selected={source === 'vanilla'} onClick={() => void changeSource('vanilla')}>原版物品</button>
            </div>
            <div className="item-editor-filter"><label><Search size={15} /><input aria-label="筛选物品" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或 ID" /></label><select aria-label="筛选类型" value={kindFilter} onChange={event => setKindFilter(event.target.value as VanillaItemKind | 'all')}><option value="all">全部类型</option>{(source === 'vanilla' ? vanillaKinds : kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div>
            {source === 'project' ? <>
              {visibleProjectItems.length === 0 ? <p className="item-editor-empty">{state.items.length ? '没有匹配的物品' : '暂无物品'}</p> : null}
              {visibleProjectItems.map(item => <button key={item.id} className={`item-editor-row${selectedId === item.id ? ' active' : ''}`} onClick={() => void select(item)}>
                <Package size={16} /><span><strong>{item.name}</strong><small>{project.namespace}:{item.id}</small></span>
              </button>)}
            </> : <>
              {!vanillaItems && !vanillaError ? <p className="item-editor-empty" role="status">正在载入原版物品…</p> : null}
              {vanillaError ? <div className="item-editor-catalog-error" role="alert"><span>{vanillaError}</span><button type="button" onClick={() => setVanillaError('')}>重试</button></div> : null}
              {vanillaItems && visibleVanillaItems.length === 0 ? <p className="item-editor-empty">没有匹配的物品</p> : null}
              {visibleVanillaItems.map(item => <button key={item.id} className={`item-editor-row${selectedVanillaId === item.id ? ' active' : ''}`} onClick={() => setSelectedVanillaId(item.id)}>
                {item.kind === 'block' ? <Box size={16} /> : <Package size={16} />}<span><strong>{item.name}</strong><small>minecraft:{item.id}</small></span>
              </button>)}
            </>}
          </aside>
          <div className="item-editor-detail">
            <div className="item-editor-detail-heading">
              <h2>{source === 'vanilla' ? selectedVanilla?.name ?? '原版物品' : selectedId ? draft.name || draft.id : '新建物品'}</h2>
              {source === 'vanilla' ? <span className="item-editor-readonly">原版 · 只读</span> : <div className="item-editor-detail-actions">
                {dirty ? <span className="item-editor-dirty">未保存</span> : null}
                {selectedId ? <button className="icon-button danger" type="button" title="删除物品" aria-label="删除物品" onClick={() => void remove()} disabled={busy}><Trash2 size={16} /></button> : null}
                <button className="primary-button" type="button" disabled={!dirty || !valid || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存物品</button>
              </div>}
            </div>
            {(source === 'project' || selectedVanilla) ? <div className="item-editor-preview" aria-label="物品预览">
              <div className="item-editor-icon-pane"><span>图标</span><div className="item-editor-preview-image">{currentPreview.data?.icon ? <img src={currentPreview.data.icon} alt="物品图标" /> : currentPreview.loading || currentPreview.data?.model ? <LoaderCircle className="spin" size={20} /> : <Package size={28} />}</div></div>
              <div className="item-editor-model-pane"><span>{itemSprite ? '掉落物模型' : '模型'}</span><div className="item-editor-model-stage">
                {displayModel || itemSprite ? <><Suspense fallback={null}><ModelCanvas model={displayModel} itemSprite={itemSprite} captureThumbnail={currentPreview.data?.needsThumbnail} onRendered={onModelRendered} /></Suspense>{renderedModelKey !== previewKey ? <div className="item-editor-model-cover">{currentPreview.data?.icon ? <img src={currentPreview.data.icon} alt="" /> : <LoaderCircle className="spin" size={20} />}</div> : null}</>
                  : <div className="item-editor-model-empty">{currentPreview.loading ? <LoaderCircle className="spin" size={20} /> : currentPreview.failed ? '预览暂不可用' : '暂无模型'}</div>}
              </div></div>
            </div> : null}
            {source === 'vanilla' ? selectedVanilla ? <dl className="item-editor-facts"><div><dt>物品 ID</dt><dd>minecraft:{selectedVanilla.id}</dd></div><div><dt>类型</dt><dd>{vanillaKinds.find(([kind]) => kind === selectedVanilla.kind)?.[1]}</dd></div><div><dt>堆叠数</dt><dd>{selectedVanilla.stackSize}</dd></div>{selectedVanilla.maxDurability ? <div><dt>耐久</dt><dd>{selectedVanilla.maxDurability}</dd></div> : null}</dl> : null : <>
            {validationMessage ? <div className="item-editor-validation" role="alert">{validationMessage}</div> : null}
            <div className="item-editor-fields">
              <label><span>物品 ID</span><input value={draft.id} disabled={Boolean(selectedId) || busy} maxLength={64} placeholder="copper_hammer" title="创建后不可更改" onChange={event => setDraft({ ...draft, id: event.target.value.toLowerCase() })} /></label>
              <label><span>中文名称</span><input value={draft.name} disabled={busy} maxLength={80} placeholder="铜锤" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
              <label><span>英文名称</span><input value={draft.englishName} disabled={busy} maxLength={80} placeholder="Copper Hammer" onChange={event => setDraft({ ...draft, englishName: event.target.value })} /></label>
              <label><span>类型</span><select value={draft.kind} disabled={busy} onChange={event => changeKind(event.target.value as ManagedItemKind)}>{kinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
              <label><span>堆叠数</span><input type="number" min={1} max={99} value={draft.stackSize} disabled={busy || draft.durability > 0 || draft.kind !== 'item'} onChange={event => setDraft({ ...draft, stackSize: Number(event.target.value) })} /></label>
              <label><span>耐久（0 为无耐久）</span><input type="number" min={0} max={100000} value={draft.durability} disabled={busy} onChange={event => setDraft({ ...draft, durability: Number(event.target.value), stackSize: Number(event.target.value) > 0 ? 1 : draft.stackSize })} /></label>
              {draft.kind !== 'item' && draft.kind !== 'armor' ? <>
                <label><span>工具等级</span><select value={draft.tier ?? 'iron'} disabled={busy} onChange={event => setDraft({ ...draft, tier: event.target.value as ManagedItem['tier'] })}>{tiers.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>攻击伤害</span><input type="number" min={0} max={100} step={draft.kind === 'sword' || project.minecraftVersion === '1.20.1' && ['pickaxe', 'hoe'].includes(draft.kind) ? 1 : 0.5} value={draft.attackDamage ?? 3} disabled={busy} onChange={event => setDraft({ ...draft, attackDamage: Number(event.target.value) })} /></label>
                <label><span>攻击速度</span><input type="number" min={-4} max={4} step={0.1} value={draft.attackSpeed ?? -2.4} disabled={busy} onChange={event => setDraft({ ...draft, attackSpeed: Number(event.target.value) })} /></label>
              </> : null}
              {draft.kind === 'armor' ? <>
                <label><span>护甲槽位</span><select value={draft.armorSlot ?? 'helmet'} disabled={busy} onChange={event => setDraft({ ...draft, armorSlot: event.target.value as ManagedItem['armorSlot'] })}>{armorSlots.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>护甲材质</span><select value={draft.armorMaterial ?? 'iron'} disabled={busy} onChange={event => setDraft({ ...draft, armorMaterial: event.target.value as ManagedItem['armorMaterial'] })}>{armorMaterials.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </> : null}
              <div className="item-editor-texture-field"><span>物品贴图</span><div className="item-editor-texture-control"><select aria-label="物品贴图" value={draft.texture} disabled={busy} onChange={event => setDraft({ ...draft, texture: event.target.value })}>{textureOptions.map(texture => <option key={texture} value={texture}>{texture}</option>)}</select><button className="secondary-button" type="button" disabled={busy} onClick={() => void importTexture()}><Upload size={15} />导入 PNG</button></div></div>
            </div>
            </>}
          </div>
        </div>}
    {dialog}
  </section>
}
