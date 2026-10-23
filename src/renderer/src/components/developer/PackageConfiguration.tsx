import { Plus, Trash2 } from 'lucide-react'

export default function PackageConfiguration({ content, readOnly, onChange }: { content: string; readOnly: boolean; onChange: (value: string) => void }): React.JSX.Element {
  let manifest: any
  try { manifest = JSON.parse(content) } catch { return <div className="developer-panel-message">清单不是有效 JSON，请切换到源码修正。</div> }
  const update = (mutate: (value: any) => void): void => { const value = structuredClone(manifest); mutate(value); onChange(JSON.stringify(value, null, 2) + '\n') }
  return <div className="developer-configuration">
    <fieldset disabled={readOnly}><legend>包信息</legend>
      <label>包 ID<input value={manifest.id ?? ''} readOnly /></label>
      <label>名称<input value={manifest.name ?? ''} maxLength={80} onChange={event => update(value => { value.name = event.target.value })} /></label>
      <label>版本<input value={manifest.version ?? ''} placeholder="1.0.0" onChange={event => update(value => { value.version = event.target.value })} /></label>
    </fieldset>
    {(manifest.views ?? []).map((view: any, index: number) => <fieldset disabled={readOnly} key={view.id}><legend>页面 · {view.id}</legend><label>导航名称<input value={view.label} onChange={event => update(value => { value.views[index].label = event.target.value })} /></label><label>分组<input value={view.group ?? ''} onChange={event => update(value => { value.views[index].group = event.target.value })} /></label></fieldset>)}
    {(manifest.studios ?? []).map((studio: any, si: number) => <div key={studio.id}>
      <fieldset disabled={readOnly}><legend>工作台 · {studio.id}</legend><label>工作台名称<input value={studio.name} onChange={event => update(value => { value.studios[si].name = event.target.value })} /></label></fieldset>
      <fieldset disabled={readOnly}><legend>创建字段</legend>
        {(studio.creation?.fields ?? []).map((field: any, fi: number) => <div className="developer-schema-field" key={fi}>
          <div className="developer-field-heading"><strong>{field.title || field.id || '新字段'}</strong><button type="button" className="icon-button" title="移除字段" aria-label={`移除字段 ${field.id}`} onClick={() => update(value => { value.studios[si].creation.fields.splice(fi, 1) })}><Trash2 size={14} /></button></div>
          <div className="developer-field-grid">
            <label>字段 ID<input value={field.id} onChange={event => update(value => { value.studios[si].creation.fields[fi].id = event.target.value })} /></label>
            <label>标题<input value={field.title} onChange={event => update(value => { value.studios[si].creation.fields[fi].title = event.target.value })} /></label>
            <label>控件<select value={field.type} onChange={event => update(value => { const target = value.studios[si].creation.fields[fi]; target.type = event.target.value; if (target.type !== 'input') target.options ??= [{ value: 'default', title: '默认' }]; else delete target.options })}><option value="input">文本输入</option><option value="select">下拉选择</option><option value="options">选项组</option></select></label>
            <label>绑定<select value={field.bind ?? ''} onChange={event => update(value => { const target = value.studios[si].creation.fields[fi]; if (event.target.value) target.bind = event.target.value; else delete target.bind })}><option value="">自定义配置</option><option value="name">项目名称</option><option value="loader">平台</option><option value="minecraftVersion">目标版本</option></select></label>
            <label>默认值<input value={field.default ?? ''} onChange={event => update(value => { value.studios[si].creation.fields[fi].default = event.target.value })} /></label>
            <div className="developer-inline-options"><label><input type="checkbox" checked={!!field.required} onChange={event => update(value => { value.studios[si].creation.fields[fi].required = event.target.checked })} />必填</label><label><input type="checkbox" checked={!!field.readOnly} onChange={event => update(value => { value.studios[si].creation.fields[fi].readOnly = event.target.checked })} />只读</label></div>
          </div>
          {field.type !== 'input' ? <label>选项（每行：值 = 名称）<textarea value={(field.options ?? []).map((option: any) => `${option.value} = ${option.title}`).join('\n')} onChange={event => update(value => { value.studios[si].creation.fields[fi].options = event.target.value.split('\n').map(line => { const [key, ...title] = line.split('='); return { value: key.trim(), title: title.join('=').trim() } }) })} /></label> : null}
        </div>)}
        <button type="button" className="secondary-button compact" onClick={() => update(value => { value.studios[si].creation ??= { fields: [] }; value.studios[si].creation.fields.push({ id: `field-${value.studios[si].creation.fields.length + 1}`, title: '新字段', type: 'input', default: '' }) })}><Plus size={14} />添加字段</button>
      </fieldset>
      <fieldset disabled={readOnly}><legend>AI 上下文</legend>{(['workbench', 'inspiration'] as const).map(surface => <label key={surface}>{surface === 'workbench' ? '工作台' : '灵感台'}<textarea className="developer-profile-input" value={studio.ai?.[surface]?.instructions ?? ''} onChange={event => update(value => { value.studios[si].ai[surface].instructions = event.target.value })} /></label>)}</fieldset>
    </div>)}
  </div>
}
