import { useEffect, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import type { LoaderVersionOption, ProjectInfo } from '../../../shared/types'
import { studioFieldVisible, studioFormInput, studioFormValues, studioCreationRecords, type StudioDefinition, type StudioFormField } from '../../../shared/studios'
import { useFeaturePlugins } from '../featurePlugins'

function fieldOptions(field: StudioFormField, values: Record<string, string>, catalog: LoaderVersionOption[]) {
  if (field.source) return catalog.filter(option => option.loader === values[field.source!.loaderField]).map(option => ({ value: option.minecraftVersion, title: option.minecraftVersion }))
  return (field.options ?? []).filter(option => studioFieldVisible(option.when, values))
}
function reconcile(definition: StudioDefinition, values: Record<string, string>, catalog: LoaderVersionOption[]): Record<string, string> {
  const next = { ...values }
  for (let pass = 0; pass < 3; pass++) for (const field of definition.creation?.fields ?? []) {
    if (!studioFieldVisible(field.when, next) || field.type === 'input') continue
    const options = fieldOptions(field, next, catalog)
    if (options.length && !options.some(option => option.value === next[field.id])) next[field.id] = options.find(option => option.value === field.default)?.value ?? options[0].value
  }
  return next
}

export function StudioFields({ definition, values, onChange, disabled = false, lockedBindings = [], versionCandidates }: {
  definition: StudioDefinition; values: Record<string, string>; onChange: (values: Record<string, string>) => void; disabled?: boolean; lockedBindings?: Array<NonNullable<StudioFormField['bind']>>; versionCandidates?: string[]
}): React.JSX.Element {
  const [manualVersion, setManualVersion] = useState(false)
  const dynamic = Boolean(definition.creation?.fields.some(field => field.source))
  const [catalog, setCatalog] = useState<LoaderVersionOption[]>([])
  const [loading, setLoading] = useState(dynamic)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!dynamic) { setLoading(false); return }
    let alive = true
    setLoading(true); setError('')
    void window.modmind.project.listLoaderVersions(revision > 0).then(options => { if (alive) setCatalog(options) })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [dynamic, revision])
  useEffect(() => {
    const next = reconcile(definition, values, catalog)
    if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next)
  }, [definition, values, catalog, onChange])
  const change = (id: string, value: string): void => onChange(reconcile(definition, { ...values, [id]: value }, catalog))
  return <div className="studio-declared-fields">
    {(definition.creation?.fields ?? []).filter(field => studioFieldVisible(field.when, values)).map(field => {
      const options = fieldOptions(field, values, catalog)
      const fieldDisabled = disabled || field.readOnly || Boolean(field.bind && lockedBindings.includes(field.bind))
      return <div className="field-label studio-declared-field" key={field.id} data-onboarding-field={field.id} data-onboarding-bind={field.bind} data-onboarding-readonly={Boolean(fieldDisabled)}>
        <label htmlFor={`studio-field-${field.id}`}>{field.title}</label>
        {field.bind === 'minecraftVersion' && versionCandidates && versionCandidates.length > 1 ? <>
          <select id={`studio-field-${field.id}`} value={manualVersion ? '__manual__' : values[field.id] ?? ''} disabled={fieldDisabled} onChange={event => { const manual = event.target.value === '__manual__'; setManualVersion(manual); change(field.id, manual ? '' : event.target.value) }}><option value="" disabled>请选择目标版本</option>{versionCandidates.map(version => <option key={version} value={version}>{version}</option>)}<option value="__manual__">手动输入</option></select>
          {manualVersion ? <input aria-label="手动填写 Minecraft 版本" value={values[field.id] ?? ''} disabled={fieldDisabled} onChange={event => change(field.id, event.target.value)} /> : null}
        </> : field.type === 'input' ? <input id={`studio-field-${field.id}`} value={values[field.id] ?? ''} maxLength={field.maxLength} placeholder={field.placeholder} required={field.required} disabled={fieldDisabled} onChange={event => change(field.id, event.target.value)} />
          : field.type === 'options' ? <div id={`studio-field-${field.id}`} className="segmented-control" role="group" aria-label={field.title}>{options.map(option => <button data-onboarding-value={option.value} type="button" key={option.value} disabled={fieldDisabled} aria-pressed={values[field.id] === option.value} className={values[field.id] === option.value ? 'active' : ''} onClick={() => change(field.id, option.value)}>{option.title}</button>)}</div>
            : <div className="studio-field-select"><select id={`studio-field-${field.id}`} value={values[field.id] ?? ''} required={field.required} disabled={fieldDisabled || Boolean(field.source && loading)} onChange={event => change(field.id, event.target.value)}>
              {!options.some(option => option.value === values[field.id]) && values[field.id] ? <option value={values[field.id]}>{values[field.id]}</option> : null}
              {options.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}
            </select>{field.source ? <button type="button" className="icon-button" disabled={disabled || loading} title="刷新版本目录" onClick={() => setRevision(value => value + 1)}>{loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button> : null}</div>}
      </div>
    })}
    {error ? <div className="inline-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
  </div>
}

export default function CreateProjectDialog({ onClose, onCreated, initialStudioId }: { onClose: () => void; onCreated: (project: ProjectInfo) => void; initialStudioId?: string }): React.JSX.Element {
  const features = useFeaturePlugins()
  const records = studioCreationRecords(features.records, features.catalog)
  const [studioId, setStudioId] = useState(initialStudioId ?? '')
  const selected = records.find(record => record.definition.id === studioId) ?? records[0]
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const definition = selected?.definition
  const optionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const options = optionsRef.current
    if (!options) return
    const revealSelected = (): void => {
      const active = options.querySelector('[aria-pressed="true"]')
      if (!active) return
      const viewport = options.getBoundingClientRect(), button = active.getBoundingClientRect()
      if (button.left < viewport.left) options.scrollLeft += button.left - viewport.left
      else if (button.right > viewport.right) options.scrollLeft += button.right - viewport.right
    }
    revealSelected()
    const observer = new ResizeObserver(revealSelected)
    observer.observe(options)
    return () => observer.disconnect()
  }, [definition?.id, records.length])
  const values = definition ? drafts[definition.id] ?? studioFormValues(definition) : {}
  const setValues = (next: Record<string, string>): void => {
    if (definition) setDrafts(current => ({ ...current, [definition.id]: next }))
  }
  const create = async (): Promise<void> => {
    if (!definition || !selected.available) return
    setBusy(true); setError('')
    try {
      const project = await window.modmind.project.create(studioFormInput(definition, values))
      if (project) onCreated(project)
      else setBusy(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
    <div className="dialog studio-create-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onMouseDown={event => event.stopPropagation()}>
      <div className="dialog-header"><h2>新建项目</h2><button className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
      <div className="segmented-control studio-selector" role="group" aria-label="工作台">
        {records.length ? <div className="studio-selector-options" ref={optionsRef}>{records.map(record => <button data-onboarding-studio={record.definition.id} type="button" key={record.definition.id} disabled={busy} aria-pressed={selected?.definition.id === record.definition.id} className={selected?.definition.id === record.definition.id ? 'active' : ''} onClick={() => setStudioId(record.definition.id)}>{record.definition.name.replace(/工作台$/, '')}</button>)}</div> : null}
      </div>
      {definition ? <StudioFields key={definition.id} definition={definition} values={values} onChange={setValues} disabled={busy} /> : <div className="adapter-note"><span>{features.ready ? '暂无可用于新建项目的工作台' : '正在加载工作台'}</span>{!features.ready ? <LoaderCircle className="spin" size={16} /> : null}</div>}
      {error ? <div data-onboarding="create-error" className="inline-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
      <div className="dialog-footer"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button data-onboarding="create-submit" className="primary-button" disabled={busy || !selected?.available || !definition?.creation} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建项目</button></div>
    </div>
  </div>
}
