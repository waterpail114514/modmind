import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Download, LoaderCircle, Music2, Plus, Save, Search, SlidersHorizontal, Trash2, Volume2 } from 'lucide-react'
import type { SoundLibraryItem } from '../../../shared/soundLibrary'
import { changeEffectParameter, draftToMidi, effectParameter, effectPresetLabels, effectSettings, mutateEffect, newStudioDraft, parseStudioDraft, renderStudio, type EffectPreset, type StudioDraft } from './soundStudioEngine'
import { renderBeepBoxSong } from './beepboxMusic'
import BeepBoxEditor from './BeepBoxEditor'
import { reportClientFailure } from '../lib/clientFailure'

const parameters = [
  { key: 'waveform', label: '波形' }, { key: 'frequency', label: '频率' }, { key: 'frequencySweep', label: '频率滑动' },
  { key: 'attack', label: '起音' }, { key: 'sustain', label: '持续' }, { key: 'decay', label: '衰减' },
  { key: 'vibratoDepth', label: '颤音' }, { key: 'bitCrush', label: '位深压缩' },
  { key: 'lowPassCutoff', label: '低通' }, { key: 'highPassCutoff', label: '高通' }
]
function soundBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1]
  if (!dataUrl.startsWith('data:audio/wav;base64,') || !base64) throw new Error('试听结果不是 WAV 音频')
  const binary = atob(base64), bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export default function SoundStudio({ projectPath, onFilesChanged }: { projectPath: string; onFilesChanged: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState<StudioDraft>(newStudioDraft)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'render' | 'save' | 'sources' | ''>('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState('')
  const [wav, setWav] = useState<Uint8Array | null>(null)
  const [layerPicker, setLayerPicker] = useState(false)
  const [sourceQuery, setSourceQuery] = useState('')
  const [sources, setSources] = useState<SoundLibraryItem[]>([])
  const [musicView, setMusicView] = useState<'notes' | 'tracks' | 'settings'>('notes')
  const [musicHasNotes, setMusicHasNotes] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const previewUrl = useRef('')
  const api = window.modmind.production.sounds
  const draftKey = 'modmind.sound.studio.' + projectPath

  const setAudio = (bytes: Uint8Array): void => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }))
    setPreview(previewUrl.current); setWav(bytes)
  }
  const update = (next: StudioDraft): void => {
    setDraft(next); setDirty(true); setWav(null); setPreview('')
    if (previewUrl.current) { URL.revokeObjectURL(previewUrl.current); previewUrl.current = '' }
  }
  useEffect(() => {
    let active = true
    void api.readDraft(projectPath).then(value => {
      if (!active) return
      const local = localStorage.getItem(draftKey)
      if (local) { setDraft(parseStudioDraft(local)); setDirty(true); setNotice('已恢复未保存的制作工程') }
      else if (value) setDraft(parseStudioDraft(value))
    }).catch(error => { if (active) setNotice(reportClientFailure(error)) }).finally(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [projectPath])
  useEffect(() => { if (dirty) try { localStorage.setItem(draftKey, JSON.stringify(draft)) } catch { /* Disk save remains available. */ } }, [draft, dirty, draftKey])
  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current) }, [])

  const renderBytes = async (): Promise<Uint8Array> => draft.mode === 'effect'
    ? soundBytes((await api.renderEffect(projectPath, draft)).dataUrl)
    : draft.music.beepboxSong ? renderBeepBoxSong(draft.music.beepboxSong, draft.gain) : renderStudio(draft)
  const render = async (): Promise<void> => {
    setBusy('render'); setNotice('')
    try { setAudio(await renderBytes()) }
    catch (error) { setNotice(reportClientFailure(error)) }
    finally { setBusy('') }
  }
  const saveDraft = async (): Promise<void> => {
    setBusy('save')
    try { await api.saveDraft(projectPath, JSON.stringify(draft)); localStorage.removeItem(draftKey); setDirty(false); setNotice('制作工程已保存') }
    catch (error) { setNotice(reportClientFailure(error)) }
    finally { setBusy('') }
  }
  const exportSound = async (): Promise<void> => {
    setBusy('save'); setNotice('')
    try {
      const bytes = wav ?? await renderBytes()
      await api.saveRendered(projectPath, draft.eventId.trim(), bytes, draft.mode === 'music')
      await api.saveDraft(projectPath, JSON.stringify(draft))
      setAudio(bytes); localStorage.removeItem(draftKey); setDirty(false); onFilesChanged()
      setNotice('已导出到项目声音事件 ' + draft.eventId.trim())
    } catch (error) { setNotice(reportClientFailure(error)) }
    finally { setBusy('') }
  }
  const exportLegacyMidi = async (): Promise<void> => { try { if (await api.exportMidi(projectPath, draftToMidi(draft))) setNotice('旧工程 MIDI 已导出，可在 BeepBox 的 File 菜单中导入') } catch (error) { setNotice(reportClientFailure(error)) } }
  const openLayerPicker = async (): Promise<void> => {
    setLayerPicker(true)
    if (sources.length) return
    setBusy('sources')
    try { setSources((await api.list(projectPath)).items.filter(item => item.available)) }
    catch (error) { setNotice(reportClientFailure(error)) }
    finally { setBusy('') }
  }
  const matchedSources = useMemo(() => {
    const query = sourceQuery.trim().toLowerCase()
    return query ? sources.filter(item => [item.name, item.eventId, item.path, item.sourceLabel].some(value => value?.toLowerCase().includes(query))).slice(0, 40) : sources.slice(0, 40)
  }, [sources, sourceQuery])
  const hasLegacyMusic = !draft.music.beepboxSong && (draft.music.tracks.some(track => track.notes.some(row => row.length)) || draft.music.drums.some(Boolean))

  return <div className="production-pane sound-studio-pane authoring-workspace">
    <div className="sound-studio-toolbar">
      <div className="sound-mode" role="group" aria-label="制作类型">
        <button type="button" className={draft.mode === 'effect' ? 'active' : ''} onClick={() => update({ ...draft, mode: 'effect' })}><Volume2 size={15} />音效</button>
        <button type="button" className={draft.mode === 'music' ? 'active' : ''} onClick={() => update({ ...draft, mode: 'music' })}><Music2 size={15} />音乐</button>
      </div>
      <span className="sound-studio-state">{dirty ? '未保存' : '已保存'}</span>
      <button className="secondary-button compact" type="button" disabled={Boolean(busy) || !dirty} onClick={() => void saveDraft()}><Save size={14} />保存工程</button>
    </div>
    <div className="sound-studio-body">{draft.mode === 'effect' ? <>
      <div className="sound-studio-controls sound-effect-controls">
        <label>音效类型<select value={draft.effect.preset} onChange={event => { const preset = event.target.value as EffectPreset; update({ ...draft, effect: { ...draft.effect, preset, settings: effectSettings(preset) } }) }}>{Object.entries(effectPresetLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <button className="secondary-button compact" type="button" onClick={() => update({ ...draft, effect: { ...draft.effect, settings: mutateEffect(draft.effect.settings) } })}><SlidersHorizontal size={14} />生成变体</button>
      </div>
      <div className="sound-effect-parameters">{parameters.map(({ key, label }) => {
        const parameter = effectParameter(draft.effect.settings, key)
        const step = key.includes('requency') || key.includes('Cutoff') ? 1 : .01
        return <label key={key}><span>{label}<output>{typeof parameter.value === 'number' ? Number(parameter.value.toFixed(step === 1 ? 0 : 2)) : ''}</output></span>{parameter.values
          ? <select value={String(parameter.value)} onChange={event => update({ ...draft, effect: { ...draft.effect, settings: changeEffectParameter(draft.effect.settings, key, event.target.value) } })}>{Object.entries(parameter.values).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select>
          : <input type="range" value={Number(parameter.value)} min={parameter.minValue ?? 0} max={parameter.maxValue ?? 100} step={step} onChange={event => update({ ...draft, effect: { ...draft.effect, settings: changeEffectParameter(draft.effect.settings, key, Number(event.target.value)) } })} />}</label>
      })}</div>
      <div className="sound-layer-heading"><strong>素材层</strong><button className="secondary-button compact" type="button" disabled={draft.effect.layers.length >= 4 || Boolean(busy)} onClick={() => void openLayerPicker()}><Plus size={14} />添加素材</button></div>
      {layerPicker ? <div className="sound-layer-picker"><label className="sound-search"><Search size={14} /><span className="visually-hidden">搜索素材</span><input value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} placeholder="搜索项目、原版或素材库音频" /></label><div className="sound-layer-results">{matchedSources.map(item => <button key={item.id} type="button" onClick={() => { update({ ...draft, effect: { ...draft.effect, layers: [...draft.effect.layers, { sourceId: item.id, name: item.name, offset: 0, gain: .7, rate: 1 }] } }); setLayerPicker(false) }}><span>{item.name}</span><small>{item.sourceLabel} · {item.eventId || item.path}</small></button>)}{!matchedSources.length ? <span className="sound-library-empty">{busy === 'sources' ? '读取素材中' : '没有匹配的本地音频'}</span> : null}</div></div> : null}
      <div className="sound-layer-list">{draft.effect.layers.map((layer, index) => {
        const changeLayer = (patch: Partial<typeof layer>): void => update({ ...draft, effect: { ...draft.effect, layers: draft.effect.layers.map((item, offset) => offset === index ? { ...item, ...patch } : item) } })
        return <div className="sound-layer-row" key={index}><strong title={layer.sourceId}>{layer.name}</strong>
          <label><span>起点 <output>{layer.offset.toFixed(1)} 秒</output></span><input type="range" min={0} max={30} step={.1} value={layer.offset} onChange={event => changeLayer({ offset: Number(event.target.value) })} /></label>
          <label><span>音量 <output>{Math.round(layer.gain * 100)}%</output></span><input type="range" min={0} max={2} step={.05} value={layer.gain} onChange={event => changeLayer({ gain: Number(event.target.value) })} /></label>
          <label><span>速率 <output>{layer.rate.toFixed(2)}×</output></span><input type="range" min={.5} max={2} step={.05} value={layer.rate} onChange={event => changeLayer({ rate: Number(event.target.value) })} /></label>
          <button className="icon-button danger" type="button" title="移除素材层" aria-label={'移除 ' + layer.name} onClick={() => update({ ...draft, effect: { ...draft.effect, layers: draft.effect.layers.filter((_, offset) => offset !== index) } })}><Trash2 size={15} /></button></div>
      })}</div>
    </> : <>
      {hasLegacyMusic ? <div className="sound-legacy-music"><span>原有工程可导出 MIDI 后在 BeepBox 中继续编辑</span><button className="secondary-button compact" type="button" onClick={() => void exportLegacyMidi()}><Download size={14} />导出旧 MIDI</button></div> : null}
      <div className="sound-mode sound-beepbox-view-tabs" role="group" aria-label="音乐编辑视图"><button type="button" className={musicView === 'notes' ? 'active' : ''} onClick={() => setMusicView('notes')}>音符</button><button type="button" className={musicView === 'tracks' ? 'active' : ''} onClick={() => setMusicView('tracks')}>编排</button><button type="button" className={musicView === 'settings' ? 'active' : ''} onClick={() => setMusicView('settings')}>音色</button></div>
      {loaded ? <BeepBoxEditor song={draft.music.beepboxSong ?? ''} view={musicView} onChange={(song, hasNotes) => { setMusicHasNotes(hasNotes); if (song !== draft.music.beepboxSong) update({ ...draft, music: { ...draft.music, beepboxSong: song } }) }} /> : null}
    </>}</div>
    <div className="sound-studio-footer"><label>输出事件 ID<input value={draft.eventId} onChange={event => update({ ...draft, eventId: event.target.value })} placeholder={draft.mode === 'music' ? 'music/theme' : 'ui/confirm'} /></label><label>总音量 <output>{Math.round(draft.gain * 100)}%</output><input type="range" min={.05} max={1} step={.05} value={draft.gain} onChange={event => update({ ...draft, gain: Number(event.target.value) })} /></label><div className="sound-studio-actions"><button className="secondary-button compact" type="button" disabled={Boolean(busy) || draft.mode === 'music' && !musicHasNotes} onClick={() => void render()}>{busy === 'render' ? <LoaderCircle className="spin" size={14} /> : <SlidersHorizontal size={14} />}生成试听</button><button className="primary-button compact" type="button" disabled={Boolean(busy) || !draft.eventId.trim() || draft.mode === 'music' && !musicHasNotes} onClick={() => void exportSound()}>{busy === 'save' ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}导出到项目</button></div></div>
    <div className="sound-studio-preview">{preview ? <audio controls src={preview} /> : <span>{draft.mode === 'music' && !musicHasNotes ? '添加音符后可生成试听' : '生成后可试听'}</span>}</div>
    {notice ? <div className="authoring-feedback" role="status"><CircleAlert size={14} />{notice}</div> : null}
  </div>
}
