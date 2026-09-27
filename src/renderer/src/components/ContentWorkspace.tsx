import { useState } from 'react'
import { Check, LoaderCircle, Plus, ShieldCheck, X } from 'lucide-react'
import type { ContentKind } from '../../../shared/production'
import { reportClientFailure as errorMessage } from '../lib/clientFailure'
import MoreActions from './MoreActions'
import './authoring-pages.css'

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

export default function ContentWorkspace({ onFilesChanged }: { onFilesChanged: () => void }): React.JSX.Element {
  const [kind, setKind] = useState<ContentKind>('language')
  const [id, setId] = useState('')
  const [locale, setLocale] = useState('zh_cn')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [resultId, setResultId] = useState('')
  const [count, setCount] = useState(1)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeTone, setNoticeTone] = useState<'success' | 'error'>('success')
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
      await window.modmind.production.content.create({ kind, id, locale, data })
      setNoticeTone('success')
      setNotice(`已生成${contentKinds.find(item => item.id === kind)?.label ?? '文件'}`)
      onFilesChanged()
    } catch (error) {
      setNoticeTone('error')
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
      setNoticeTone('error')
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

  return <div className="production-page"><div className="production-pane content-pane authoring-workspace">
    <h2 className="visually-hidden">内容与数据</h2>
    <div className="authoring-toolbar">
      <label className="authoring-kind">内容类型<select aria-label="内容类型" value={kind} disabled={Boolean(busy)} onChange={event => setKind(event.target.value as ContentKind)}>
        <optgroup label="常用">{contentKinds.filter(item => !item.id.endsWith('-json')).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>
        <optgroup label="高级">{contentKinds.filter(item => item.id.endsWith('-json')).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>
      </select></label>
      <MoreActions label="内容更多操作"><button type="button" disabled={Boolean(busy)} onClick={() => void validate()}><ShieldCheck size={15} />验证资源</button></MoreActions>
    </div>
    <form className="authoring-form" onSubmit={event => { event.preventDefault(); void create() }}>
      <fieldset className="authoring-fields" disabled={Boolean(busy)}>
        <label>{rawJson ? '相对路径' : '资源 ID'}<input required value={id} onChange={event => setId(event.target.value)} placeholder={rawJson ? 'worldgen/biome/example' : 'example/path'} /></label>
        {kind === 'language' ? <label>语言<select aria-label="语言" value={locale} onChange={event => setLocale(event.target.value)}><option value="zh_cn">简体中文</option><option value="en_us">English</option></select></label> : null}
        <label className={rawJson ? 'authoring-field-wide' : undefined}>{labels[kind][0]}{rawJson
          ? <textarea required aria-label="JSON 内容" value={primary} onChange={event => setPrimary(event.target.value)} spellCheck={false} placeholder={'{\n  "type": "minecraft:example"\n}'} />
          : <input value={primary} onChange={event => setPrimary(event.target.value)} />}</label>
        {labels[kind][1] ? <label>{labels[kind][1]}<input required={kind === 'language'} value={secondary} onChange={event => setSecondary(event.target.value)} /></label> : null}
        {recipe ? <label>产物 ID<input required value={resultId} onChange={event => setResultId(event.target.value)} placeholder="minecraft:stone" /></label> : null}
        {recipe ? <label>数量<input type="number" min={1} max={64} value={count} onChange={event => setCount(Math.min(64, Math.max(1, Number(event.target.value))))} /></label> : null}
      </fieldset>
      <div className="authoring-actions">
        {busy === 'validate' ? <span className="authoring-status" role="status"><LoaderCircle className="spin" size={14} />正在验证资源…</span> : null}
        <button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === 'create' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{busy === 'create' ? '正在生成…' : '生成文件'}</button>
      </div>
    </form>
    {notice ? <div className={`authoring-feedback ${noticeTone}`} role={noticeTone === 'error' ? 'alert' : 'status'}>{noticeTone === 'error' ? <X size={15} /> : <Check size={15} />}<span>{notice}</span></div> : null}
    {validation ? <div className={`authoring-validation ${validation.success ? 'success' : 'error'}`}>
      <div className="authoring-feedback" role="status">{validation.success ? <Check size={15} /> : <X size={15} />}<strong>{validation.success ? '资源验证通过' : '资源验证失败'}</strong><span>{validation.checkedFiles} 个文件 · {validation.errors.length} 个错误 · {validation.warnings.length} 个警告</span></div>
      {[...validation.errors, ...validation.warnings].map((item, index) => <p key={index}>{item}</p>)}
    </div> : null}
  </div></div>
}
