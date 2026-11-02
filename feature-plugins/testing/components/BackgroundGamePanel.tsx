import { useEffect, useRef, useState } from 'react'
import { Hand, LoaderCircle, Pause, Play, RefreshCw, Square } from 'lucide-react'
import type { ProjectInfo } from '../../../src/shared/types'
import type { GameCaptureView, GameControlView } from '../../../src/shared/gameControl'
import '../background-game.css'

export default function BackgroundGamePanel({ project }: { project: ProjectInfo }): React.JSX.Element {
  const [state, setState] = useState<GameControlView>({})
  const [capture, setCapture] = useState<GameCaptureView>()
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [characters, setCharacters] = useState('')
  const [clean, setClean] = useState(false), [eula, setEula] = useState(false)
  const id = useRef<string>(), generation = useRef(0), reading = useRef(false)
  const pending = useRef(0), runningAction = useRef(false)
  const currentCapture = useRef<GameCaptureView>(), pointer = useRef<{ x: number; y: number; revision: string }>()
  const invoke = (action: string, input: Record<string, unknown>) => window.modmind.featurePlugins.invoke('testing', 'test_' + action, input)
  function acceptFrame(image?: GameCaptureView) {
    if (!image || currentCapture.current && image.frameId <= currentCapture.current.frameId) return
    currentCapture.current = image; setCapture(image)
  }
  function apply(value: GameControlView) {
    if (value.sessionId) id.current = value.sessionId
    setState(value)
    acceptFrame(value.captures?.[0])
  }
  async function refresh() {
    if (!id.current || reading.current || pointer.current || runningAction.current) return
    const version = generation.current; reading.current = true
    try {
      const next = await invoke('session', { operation: 'state', sessionId: id.current, waitSeconds: 0 }) as GameControlView
      if (version !== generation.current) return
      apply(next)
      if (next.ready && next.running) {
        const image = await invoke('capture', { sessionId: id.current }) as GameControlView
        if (version === generation.current && !pointer.current) acceptFrame(image.captures?.[0])
      }
    } catch (failure) { if (version === generation.current) setError(String(failure instanceof Error ? failure.message : failure)) }
    finally { reading.current = false }
  }
  useEffect(() => {
    const version = ++generation.current; pending.current++; runningAction.current = false; setBusy(''); id.current = undefined; currentCapture.current = undefined; setState({}); setCapture(undefined); setError(''); pointer.current = undefined
    void invoke('session', { operation: 'state', backend: 'background', waitSeconds: 0 }).then(value => { if (version === generation.current) apply(value as GameControlView) }).catch(() => undefined)
    const timer = window.setInterval(() => { void refresh() }, 2500)
    return () => { generation.current++; window.clearInterval(timer) }
  }, [project.path])
  async function run(label: string, call: () => Promise<unknown>) {
    const version = generation.current, request = ++pending.current; runningAction.current = true; setBusy(label); setError('')
    try {
      const value = await call() as GameControlView & { status?: string; error?: string }
      if (version !== generation.current) return
      if (value.error) setError(value.error)
      if (value.mode || value.status === 'stopped') apply(value)
      acceptFrame(value.captures?.[0])
      if (value.status === 'stopped') { id.current = undefined; setState({ status: 'stopped' }) }
    } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (version === generation.current && request === pending.current) { runningAction.current = false; setBusy('') } }
  }
  const session = (operation: string) => run(operation, async () => {
    const next = await invoke('session', { operation, sessionId: id.current }) as GameControlView
    return operation === 'resume' ? { ...next, ...await invoke('capture', { sessionId: id.current }) as GameControlView } : next
  })
  const action = (input: Record<string, unknown>) => run('action', () => invoke('action', { ...input, sessionId: id.current, requestId: crypto.randomUUID(), capture: true }))
  const running = Boolean(state.running), preparing = state.status === 'running' && !state.ready
  const ai = state.ready && state.ownership === 'ai'
  const label = preparing ? '正在准备游戏' : state.error ? '准备失败' : running ? state.ownership === 'human' ? '由你控制' : state.ownership === 'paused' ? 'AI 已暂停' : 'AI 后台控制中' : '尚未启动'
  function coordinates(event: React.PointerEvent<HTMLImageElement>) {
    const image = currentCapture.current; if (!image) return
    const box = event.currentTarget.getBoundingClientRect(), scale = Math.min(box.width / image.width, box.height / image.height)
    const x = (event.clientX - box.left - (box.width - image.width * scale) / 2) / scale
    const y = (event.clientY - box.top - (box.height - image.height * scale) / 2) / scale
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
    return { x, y, revision: image.revision }
  }
  return <div className="background-game-panel">
    <div className="background-game-toolbar">
      <span role="status">{preparing ? <LoaderCircle size={15} className="spin" /> : null}{label}</span>
      <div>
        {running ? <>
          <button className="secondary-button" disabled={!state.ready || Boolean(busy)} onClick={() => void session(state.ownership === 'ai' ? 'pause' : 'resume')}>{state.ownership === 'ai' ? <Pause size={15} /> : <Play size={15} />}{state.ownership === 'ai' ? '暂停 AI' : '恢复 AI'}</button>
          <button className="secondary-button" disabled={!state.ready || state.ownership === 'human' || busy === 'takeover'} onClick={() => void session('takeover')}><Hand size={15} />手动接管</button>
        </> : null}
        {running || preparing ? <button className="danger-button" disabled={busy === 'stop'} onClick={() => void session('stop')}><Square size={15} />停止测试</button> : <button className="primary-button" disabled={Boolean(busy) || project.kind === 'server-plugin' && !eula} onClick={() => void run('start', () => invoke('session', { operation: 'start', mode: 'rendered', backend: 'background', withoutProjectMod: project.kind !== 'modpack' && project.kind !== 'server-plugin' && clean, acceptEula: eula }))}><Play size={15} />启动后台测试</button>}
      </div>
    </div>
    <div className="background-game-workspace">
      <div className="background-game-view">
        <div className="background-game-image">
          {capture ? <img src={capture.dataUrl} alt={`Minecraft 游戏画面，第 ${capture.frameId} 帧`} draggable={false}
            onPointerDown={event => { if (!ai || busy || reading.current || event.button !== 0) return; pointer.current = coordinates(event); if (pointer.current) event.currentTarget.setPointerCapture(event.pointerId) }}
            onPointerCancel={() => { pointer.current = undefined }}
            onPointerUp={event => { const start = pointer.current; pointer.current = undefined; if (!start || !ai || busy) return; const end = coordinates(event); if (!end) return; void action(Math.hypot(end.x - start.x, end.y - start.y) > 4 ? { operation: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y, revision: start.revision, durationMs: 300 } : { operation: 'click', x: start.x, y: start.y, revision: start.revision }) }} />
            : <div className="background-game-placeholder">{preparing || busy === 'start' ? <LoaderCircle className="spin" size={24} /> : null}<span>{preparing ? '准备完成后显示游戏画面' : '启动后可在这里查看和操作游戏'}</span></div>}
        </div>
        <div className="background-game-framebar"><span>{capture ? `${capture.width} × ${capture.height} · 第 ${capture.frameId} 帧` : '等待游戏画面'}</span><button className="icon-button" title="更新游戏画面" disabled={!state.ready || reading.current} onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
      </div>
      <aside className="background-game-controls">
        {!running && !preparing && project.kind !== 'modpack' && project.kind !== 'server-plugin' ? <label><input type="checkbox" checked={clean} onChange={event => setClean(event.target.checked)} />不加载项目 Mod</label> : null}
        {!running && !preparing && project.kind === 'server-plugin' ? <label><input type="checkbox" checked={eula} onChange={event => setEula(event.target.checked)} />接受 Minecraft EULA 并启动本机测试服</label> : null}
        <div className="background-game-keys" aria-label="游戏按键">{['W', 'A', 'S', 'D', 'Space', 'E', 'Escape'].map(key => <button className="secondary-button" key={key} disabled={!ai || Boolean(busy)} onClick={() => void action({ operation: 'key', key, durationMs: key === 'Space' ? 100 : 200 })}>{key === 'Space' ? '跳跃' : key === 'E' ? '背包' : key === 'Escape' ? 'Esc' : key}</button>)}</div>
        <label>输入文字<textarea value={characters} maxLength={512} rows={3} disabled={!ai || Boolean(busy)} onChange={event => setCharacters(event.target.value)} /></label>
        <button className="secondary-button" disabled={!ai || !characters || Boolean(busy)} onClick={() => void action({ operation: 'text', text: characters })}>输入到游戏</button>
        <button className="secondary-button" disabled={!running} onClick={() => void run('release', () => invoke('action', { operation: 'release', sessionId: id.current }))}>松开全部按键</button>
      </aside>
    </div>
    <div className="background-game-feedback" aria-live="polite">{error || state.error ? <p role="alert">{error || state.error}</p> : preparing ? <p>正在准备测试实例，可随时停止。</p> : state.ownership === 'human' ? <p>点击游戏窗口后即可手动操作。恢复 AI 前会重新读取画面。</p> : null}</div>
  </div>
}
