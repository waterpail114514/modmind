import { useEffect, useRef, useState } from 'react'
import { Check, ImagePlus, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'
import type { AgentSettings } from '../../../shared/types'
import { getThemePalette, normalizeBackground, normalizeThemePreset, themePresets, type AppBackground } from '../../../shared/appTheme'
import { backgroundMediaUrl } from './AppBackground'

function BackgroundSlider({ label, value, max, suffix, onCommit }: { label: string; value: number; max: number; suffix: string; onCommit: (value: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => { if (draft !== value) onCommit(draft) }
  return <label className="appearance-slider"><span>{label}</span><input type="range" aria-label={label} min={0} max={max} step={1} value={draft} onChange={event => setDraft(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /><output>{draft}{suffix}</output></label>
}

export default function AppearanceSettings({ settings, onSave }: { settings: AgentSettings; onSave: (patch: Partial<AgentSettings>) => Promise<boolean> }): React.JSX.Element {
  const mode = settings.darkMode ? 'dark' : 'light'
  const preset = normalizeThemePreset(settings.themePreset)
  const palette = getThemePalette(preset, mode)
  const custom = settings.customThemeColors?.[mode]
  const [canvas, setCanvas] = useState(custom?.canvas ?? palette.canvas)
  const [accent, setAccent] = useState(custom?.accent ?? palette.action)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failedFile, setFailedFile] = useState('')
  const background = normalizeBackground(settings.background)
  const backgroundRef = useRef(background)
  backgroundRef.current = background
  useEffect(() => { setCanvas(custom?.canvas ?? palette.canvas); setAccent(custom?.accent ?? palette.action) }, [custom?.canvas, custom?.accent, palette.canvas, palette.action, mode])
  const saveBackground = (patch: Partial<AppBackground>): void => { void onSave({ background: { ...background, ...patch } }) }
  const chooseBackground = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const media = await window.modmind.settings.pickBackground()
      if (media) await onSave({ background: { ...backgroundRef.current, media } })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const resetColors = (): void => {
    const colors = { ...settings.customThemeColors }
    delete colors[mode]
    void onSave({ customThemeColors: colors })
  }
  const media = background.media
  const changed = canvas !== (custom?.canvas ?? palette.canvas) || accent !== (custom?.accent ?? palette.action)
  return <>
    <div className="settings-heading"><h2>外观</h2></div>
    <div className="appearance-row theme-preset-row">
      <strong>界面配色</strong>
      <div className="theme-preset-options" role="group" aria-label="界面配色">
        {themePresets.map(item => {
          const p = getThemePalette(item.id, mode)
          return <button type="button" key={item.id} aria-pressed={preset === item.id && !custom} title={item.description} onClick={() => void onSave({ themePreset: item.id, customThemeColors: {} })}>
            <span className="theme-swatches" aria-hidden="true"><i style={{ background: p.canvas }} /><i style={{ background: p.action }} /><i style={{ background: p.detail }} /></span>
            {item.label}<Check size={13} className="theme-preset-check" />
          </button>
        })}
      </div>
    </div>
    <div className="appearance-row"><strong>深色模式</strong><button className={`toggle ${settings.darkMode ? 'on' : ''}`} type="button" role="switch" aria-label="深色模式" aria-checked={settings.darkMode} onClick={() => void onSave({ darkMode: !settings.darkMode })}><span /></button></div>
    <details className="appearance-custom-colors">
      <summary>手动调色{custom ? <span>已自定义 · {settings.darkMode ? '深色' : '浅色'}</span> : null}</summary>
      <div className="appearance-color-controls">
        <label><span>背景色</span><input type="color" aria-label="背景色" value={canvas} onChange={event => setCanvas(event.target.value)} /><code>{canvas.toUpperCase()}</code></label>
        <label><span>强调色</span><input type="color" aria-label="强调色" value={accent} onChange={event => setAccent(event.target.value)} /><code>{accent.toUpperCase()}</code></label>
        <button type="button" className="secondary-button compact" disabled={!changed} onClick={() => void onSave({ customThemeColors: { ...settings.customThemeColors, [mode]: { canvas, accent } } })}><Check size={14} />应用颜色</button>
        <button type="button" className="appearance-icon-button" title="恢复当前模式的预设颜色" aria-label="恢复预设颜色" disabled={!custom && !changed} onClick={() => { setCanvas(palette.canvas); setAccent(palette.action); resetColors() }}><RotateCcw size={16} /></button>
      </div>
    </details>
    <div className="appearance-background-heading"><h3>自定义背景</h3><div className="appearance-background-actions">
      <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void chooseBackground()}>{busy ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}{media ? '更换背景' : '选择图片或视频'}</button>
      {media && <button type="button" className="appearance-icon-button" title="移除背景" aria-label="移除背景" onClick={() => saveBackground({ media: null })}><Trash2 size={16} /></button>}
    </div></div>
    {error && <p className="appearance-error" role="alert">{error}</p>}
    {media && <div className="appearance-background-options">
      <div className="appearance-background-preview">
        {media.file === failedFile ? <span role="alert">背景无法读取或格式不受支持，请更换文件。</span> : media.kind === 'image'
          ? <img src={backgroundMediaUrl(media.file)} alt="背景预览" onError={() => setFailedFile(media.file)} />
          : <video src={backgroundMediaUrl(media.file)} muted playsInline preload="metadata" onError={() => setFailedFile(media.file)} />}
        <span title={media.name}>{media.name}</span>
      </div>
      <div className="appearance-background-controls">
        <BackgroundSlider label="背景可见度" value={Math.round(background.opacity * 100)} max={100} suffix="%" onCommit={value => saveBackground({ opacity: value / 100 })} />
        <BackgroundSlider label="背景模糊" value={background.blur} max={24} suffix="px" onCommit={blur => saveBackground({ blur })} />
        <label className="appearance-fit"><span>图片 / 视频适配</span><select aria-label="背景适配" value={background.fit} onChange={event => saveBackground({ fit: event.target.value as AppBackground['fit'] })}><option value="cover">填满窗口</option><option value="contain">完整显示</option></select></label>
        {media.kind === 'video' && <div className="appearance-row"><strong>播放背景视频</strong><button className={`toggle ${!background.paused ? 'on' : ''}`} type="button" role="switch" aria-label="播放背景视频" aria-checked={!background.paused} onClick={() => saveBackground({ paused: !background.paused })}><span /></button></div>}
      </div>
    </div>}
  </>
}
