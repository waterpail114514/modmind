import { useEffect, useState } from 'react'
import { FolderOpen, Gamepad2, Play, RefreshCw, Square } from 'lucide-react'
import type { FeaturePageContext } from '../../sdk/renderer'
import type { ShaderTestState, ShaderRuntimeCapabilities, ShaderRuntimeSession } from '../../../src/shared/shaderStudio'
import ShaderFrame, { useShaderFeature } from '../../shader-shared/components/ShaderFrame'

export default function ShaderTesting(context: FeaturePageContext): React.JSX.Element {
  const feature = useShaderFeature(context, 'shader-testing'), { invoke, run, locked, setNotice } = feature
  const [test, setTest] = useState<ShaderTestState>(), [before, setBefore] = useState(''), [after, setAfter] = useState('')
  const [mode, setMode] = useState('manual'), [capabilities, setCapabilities] = useState<ShaderRuntimeCapabilities>(), [session, setSession] = useState<ShaderRuntimeSession | null>(null), [versionId, setVersionId] = useState('')
  const active = Boolean(session && (session.running || ['preparing', 'launching', 'ready', 'stopping'].includes(session.status)))
  const reload = () => run('refresh', async () => {
    const [test, capabilities, session] = await Promise.all([invoke<ShaderTestState>('query', { operation: 'test-state' }), invoke<ShaderRuntimeCapabilities>('query', { operation: 'capabilities' }), invoke<ShaderRuntimeSession | null>('query', { operation: 'session-state' })])
    setTest(test); setCapabilities(capabilities); setSession(session)
    setVersionId(current => capabilities.versions.some(version => version.id === current) ? current : capabilities.versions[0]?.id ?? '')
  })
  useEffect(() => { if (context.visible) void reload() }, [context.visible, invoke])
  useEffect(() => {
    if (!active || !context.visible) return
    let closed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const value = await invoke<ShaderRuntimeSession | null>('query', { operation: 'session-state', sessionId: session!.sessionId }); if (!closed) setSession(value) }
      catch { /* Explicit refresh retains an actionable error after a project switch. */ }
      finally { if (!closed) timer = setTimeout(poll, 1000) }
    }
    timer = setTimeout(poll, 1000)
    return () => { closed = true; clearTimeout(timer) }
  }, [active, context.visible, invoke, session?.sessionId])
  return <ShaderFrame context={context} view="test" feature={feature} refresh={() => void reload()}>
    <div className="shader-game">
      <div className="shader-test-modes segmented-control" role="group" aria-label="验证方式"><button aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>手动部署</button><button aria-pressed={mode === 'session'} onClick={() => setMode('session')}>隔离测试</button></div>
      {mode === 'session' ? <div className="shader-session-controls">
        <div className="shader-game-controls"><span>{test?.instancePath ?? '尚未选择 Iris 实例'}</span><button className="secondary-button compact" disabled={locked || active} onClick={() => void run('bind', async () => { const state = await invoke<ShaderTestState | null>('test', { operation: 'bind' }); if (state) { setTest(state); setCapabilities(await invoke('query', { operation: 'capabilities' })) } })}><FolderOpen size={15} />选择实例</button></div>
        <div className="shader-game-controls"><span>{capabilities?.runtimeRoot ?? '尚未选择游戏运行库'}</span><button className="secondary-button compact" disabled={locked || active || !test?.instancePath} onClick={() => void run('bind-runtime', async () => { const value = await invoke<ShaderRuntimeCapabilities | null>('test', { operation: 'bind-runtime' }); if (value) { setCapabilities(value); setVersionId(value.versions[0]?.id ?? '') } })}><FolderOpen size={15} />选择运行库</button></div>
        <div className="shader-session-actions"><select aria-label="测试游戏版本" value={versionId} disabled={locked || active || !capabilities?.versions.length} onChange={event => setVersionId(event.target.value)}><option value="">选择版本</option>{capabilities?.versions.map(version => <option key={version.id} value={version.id}>{version.id}</option>)}</select>
          <button className="primary-button compact" disabled={locked || active && session?.status !== 'ready' || !capabilities?.ready || !versionId} onClick={() => void run('session', async () => { setSession(await invoke<ShaderRuntimeSession>('session', session?.status === 'ready' ? { operation: 'reload', sessionId: session.sessionId } : { operation: 'start', versionId })) })}>{session?.status === 'ready' ? <RefreshCw size={15} /> : <Play size={15} />}{session?.status === 'ready' ? '重载光影' : '启动测试'}</button>
          <button className="icon-button" title="停止测试" disabled={!active || session?.status === 'stopping'} onClick={() => void run('stop', async () => setSession(await invoke<ShaderRuntimeSession>('session', { operation: 'stop', sessionId: session!.sessionId })))}><Square size={16} /></button>
          <button className="icon-button" title="读取游戏管线" disabled={locked || session?.status !== 'ready'} onClick={() => void run('observe', async () => setSession(await invoke<ShaderRuntimeSession>('query', { operation: 'observe', sessionId: session!.sessionId })))}><RefreshCw size={16} /></button>
        </div>
        {capabilities?.issues.length ? <div className="shader-session-issues" role="status">{capabilities.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div> : null}
        {session ? <div className="shader-session-state"><div role="status">{session.message}</div>{session.observation ? <dl><dt>实际光影</dt><dd>{session.observation.packName ?? '未加载'}</dd><dt>渲染管线</dt><dd>{session.observation.pipeline?.includes('IrisRenderingPipeline') ? 'Iris' : '等待进入世界'}</dd><dt>有效选项</dt><dd>{Object.keys(session.observation.effectiveOptions).length} 项</dd></dl> : null}
          <details><summary>会话详情</summary><dl><dt>会话</dt><dd>{session.sessionId}</dd><dt>退出期限</dt><dd>{session.expiresAt}</dd><dt>退出方式</dt><dd>{session.shutdown ?? '尚未退出'}</dd></dl>{session.logTail ? <pre>{session.logTail}</pre> : null}</details>
        </div> : null}
      </div> : <>
      <div className="shader-game-controls"><span>{test?.instancePath ?? '尚未选择 Iris 游戏实例'}</span><button className="secondary-button compact" disabled={locked} onClick={() => void run('bind', async () => { const state = await invoke<ShaderTestState | null>('test', { operation: 'bind' }); if (state) setTest(state) })}><FolderOpen size={15} />选择实例</button><button className="primary-button compact" disabled={locked || !test?.irisDetected} onClick={() => void run('deploy', async () => { setTest(await invoke<ShaderTestState>('test', { operation: 'deploy' })); setNotice('光影包已部署；在游戏中选择该包后重新读取日志') })}><Gamepad2 size={15} />部署光影</button>{test?.instancePath ? <button className="icon-button" title="打开实例目录" disabled={locked} onClick={() => void run('reveal', async () => { await invoke('test', { operation: 'reveal' }) })}><FolderOpen size={15} /></button> : null}</div>
      {test?.deployed ? <div className="shader-status">已部署 {test.deployed.deployedAt} · {test.log?.fresh ? '日志有更新' : '等待新日志'} · {test.log?.packMentioned ? '日志包含包名称' : '尚未确认游戏选中该包'}</div> : null}
      <div className="shader-game-log">{test?.log ? <><div className="shader-log-heading">游戏日志 · {test.log.modifiedAt} · {test.log.issues.length} 条错误候选</div><pre>{test.log.issues.length ? test.log.issues.join('\n') : test.log.text}</pre></> : <div className="shader-empty">{test?.irisDetected ? '尚无游戏日志' : '选择已安装 Iris 的游戏目录'}</div>}</div>
      {test?.warnings?.length ? <div className="shader-status" role="status">{test.warnings.join('；')}</div> : null}
      {test?.screenshots.length ? <div className="shader-comparison"><div className="shader-comparison-controls"><label>对比前<select aria-label="对比前" value={before || test.screenshots[0].name} onChange={event => setBefore(event.target.value)}>{test.screenshots.map(image => <option key={image.name} value={image.name}>{image.name}</option>)}</select></label><label>对比后<select aria-label="对比后" value={after || test.screenshots[Math.min(1, test.screenshots.length - 1)].name} onChange={event => setAfter(event.target.value)}>{test.screenshots.map(image => <option key={image.name} value={image.name}>{image.name}</option>)}</select></label></div><div className="shader-comparison-images">{[before || test.screenshots[0].name, after || test.screenshots[Math.min(1, test.screenshots.length - 1)].name].map((name, i) => <figure key={i}><img src={test.screenshots.find(image => image.name === name)?.dataUrl} alt={`${i ? '对比后' : '对比前'}游戏截图 ${name}`} /><figcaption>{name}</figcaption></figure>)}</div></div> : null}
      </>}
    </div>
  </ShaderFrame>
}

