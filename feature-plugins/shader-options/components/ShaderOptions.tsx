import { useEffect, useRef, useState } from 'react'
import { Save, Search, Undo2 } from 'lucide-react'
import { useConfirmDialog } from '../../../src/renderer/src/components/InteractionDialogs'
import type { FeaturePageContext } from '../../sdk/renderer'
import type { ShaderInventory } from '../../../src/shared/shaderStudio'
import ShaderFrame, { useShaderFeature } from '../../shader-shared/components/ShaderFrame'

export default function ShaderOptions(context: FeaturePageContext): React.JSX.Element {
  const feature = useShaderFeature(context, 'shader-options'), { invoke, run, locked, setNotice } = feature
  const [inventory, setInventory] = useState<ShaderInventory>(), [options, setOptions] = useState<Record<string, string>>({}), { confirm, dialog } = useConfirmDialog()
  const [search, setSearch] = useState(''), [group, setGroup] = useState(''), [preset, setPreset] = useState('')
  const [programValues, setProgramValues] = useState<Record<string, boolean>>({})
  const dirty = Boolean(inventory?.options.some(option => options[option.name] !== option.value) || Object.keys(programValues).length), dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const apply = (value: ShaderInventory) => { setInventory(value); setOptions(Object.fromEntries(value.options.map(option => [option.name, option.value]))); setProgramValues({}); setPreset('') }
  const changeOption = (name: string, value: string) => { setOptions(current => ({ ...current, [name]: value })); setPreset('') }
  const groups = inventory?.optionGroups ?? [], query = search.trim().toLowerCase(), activeGroup = groups.some(value => value.name === group) ? group : ''
  const visibleGroups = groups.filter(value => !activeGroup || value.name === activeGroup).map(value => ({ ...value, options: inventory!.options.filter(option => value.options.includes(option.name) && (!query || `${option.title} ${option.name} ${option.files.map(file => file.path).join(' ')}`.toLowerCase().includes(query))) })).filter(value => value.options.length)
  useEffect(() => { if (context.visible && !dirtyRef.current) void run('loading', async () => apply(await invoke<ShaderInventory>('query', { operation: 'inventory' }))) }, [context.visible, invoke])
  const reload = () => run('refresh', async () => {
    if (dirty && !await confirm({ title: '放弃选项的未保存修改？', message: '重新读取工程中的光影选项。', confirmLabel: '重新读取', tone: 'danger' })) return
    apply(await invoke<ShaderInventory>('query', { operation: 'inventory' }))
  })
  return <ShaderFrame context={context} view="options" feature={feature} dirty={dirty} refresh={() => void reload()} actions={<>
    <button className="icon-button" title="撤销上次保存" disabled={locked} onClick={() => void run('undo', async () => {
      if (dirty && !await confirm({ title: '放弃草稿并撤销上次保存？', message: '未保存选项会丢弃；文件有后续修改时不会覆盖。', confirmLabel: '撤销保存' })) return
      apply(await invoke<ShaderInventory>('edit', { operation: 'undo' })); context.filesChanged(); setNotice('上次保存已撤销')
    })}><Undo2 size={16} /></button>
    <button className="primary-button compact" disabled={locked || !dirty} onClick={() => void run('options', async () => {
      const changed = Object.fromEntries(inventory!.options.filter(option => options[option.name] !== option.value).map(option => [option.name, options[option.name]]))
      apply(await invoke<ShaderInventory>('edit', { operation: 'options', revision: inventory!.revision, values: changed, programValues })); context.filesChanged(); setNotice('选项已保存到源码')
    })}><Save size={15} />保存选项</button>
  </>}><div className="shader-options-list">
    {inventory && Object.keys(inventory.profiles).length ? <label className="shader-profile">画质预设<select aria-label="画质预设" value={preset} disabled={locked} onChange={event => {
      const name = event.target.value; setPreset(name)
      if (!name) return
      setOptions(current => ({ ...current, ...inventory.profiles[name] }))
      setProgramValues(Object.fromEntries(Object.entries(inventory.profilePrograms[name] ?? {}).filter(([name, value]) => inventory.programConditions[name] !== String(value))))
    }}><option value="">自定义</option>{Object.keys(inventory.profiles).map(name => <option key={name} value={name} disabled={inventory.configurationConditional && Object.keys(inventory.profilePrograms[name] ?? {}).length > 0}>{name}</option>)}</select></label> : null}
    {inventory && Object.keys(inventory.profileIssues).length ? <details className="shader-option-diagnostics"><summary>不可用预设 · {Object.keys(inventory.profileIssues).length}</summary>{Object.entries(inventory.profileIssues).map(([name, issues]) => <p key={name}>{name}：{issues.join('；')}</p>)}</details> : null}
    {inventory?.optionIssues.length ? <details className="shader-option-diagnostics"><summary>选项诊断 · {inventory.optionIssues.length}</summary>{inventory.optionIssues.map((issue, i) => <button className="shader-issue warning" key={i} onClick={() => context.openFile(issue.path)}><span>{issue.message}<code>{issue.path}{issue.line ? `:${issue.line}` : ''}</code></span></button>)}</details> : null}
    {inventory?.options.length ? <div className="shader-option-filters"><label className="shader-search"><Search size={15} /><input aria-label="搜索光影选项" placeholder="搜索选项" value={search} onChange={event => setSearch(event.target.value)} /></label>{groups.length > 1 ? <select aria-label="选项分组" value={groups.some(value => value.name === group) ? group : ''} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{groups.map(value => <option value={value.name} key={value.name}>{value.title}</option>)}</select> : null}</div> : null}
    {visibleGroups.map(value => <section className="shader-option-group" key={value.name}><h3>{value.title}</h3>{value.options.map(option => <label className="shader-option-row" key={option.name} data-option={option.name}><span><strong>{option.title}</strong><code>{option.name}</code></span>{option.values.length === 2 && option.values.includes('true') && option.values.includes('false') ? <input type="checkbox" aria-label={option.title} checked={options[option.name] === 'true'} disabled={locked} onChange={event => changeOption(option.name, String(event.target.checked))} /> : option.slider ? <span className="shader-slider"><input type="range" aria-label={option.title} min="0" max={option.values.length - 1} step="1" value={Math.max(0, option.values.indexOf(options[option.name] ?? option.value))} disabled={locked} onChange={event => changeOption(option.name, option.values[Number(event.target.value)])} /><output>{options[option.name]}</output></span> : <select aria-label={option.title} disabled={locked} value={options[option.name] ?? option.value} onChange={event => changeOption(option.name, event.target.value)}>{option.values.map(value => <option key={value} value={value}>{value}</option>)}</select>}</label>)}</section>)}
    {inventory?.options.length && !visibleGroups.length ? <div className="shader-empty">没有匹配的选项</div> : null}
    {Object.keys(programValues).length ? <section className="shader-option-group"><h3>程序修改</h3>{Object.entries(programValues).map(([name, value]) => <div className="shader-option-row" key={name}><span><strong>{name}</strong><code>{inventory?.programConditions[name] ?? '默认启用'} → {value ? '启用' : '禁用'}</code></span><button className="icon-button" title={`取消程序修改 ${name}`} disabled={locked} onClick={() => { setProgramValues(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== name))); setPreset('') }}><Undo2 size={16} /></button></div>)}</section> : null}
    {inventory && !inventory.options.length ? <div className="shader-empty">未检测到可编辑的光影选项<button className="secondary-button compact" onClick={() => context.openFile('shaders/shaders.properties')}>查看源码</button></div> : null}
  </div>{dialog}</ShaderFrame>
}
