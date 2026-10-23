import { useCallback, useRef, useState } from 'react'
import { Check, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import type { FeaturePageContext } from '../../sdk/renderer'
import './shader-workspace.css'

export function useShaderFeature(context: FeaturePageContext, pluginId: string) {
  const projectRef = useRef(context.project?.path)
  projectRef.current = context.project?.path
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const invoke = useCallback(async <T,>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
    const projectPath = context.project?.path
    const result = await window.modmind.featurePlugins.invoke(pluginId, action, { ...input, projectPath }) as T
    if (projectRef.current !== projectPath) throw new Error('项目已切换，请刷新当前工程')
    return result
  }, [context.project?.path, pluginId])
  const run = async (name: string, operation: () => Promise<void>) => {
    const projectPath = projectRef.current
    setBusy(name); setError(''); setNotice('')
    try { await operation() }
    catch (reason) { if (projectRef.current === projectPath) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (projectRef.current === projectPath) setBusy('') }
  }
  return { invoke, run, busy, error, notice, setNotice, locked: Boolean(busy || context.projectBusy) }
}

export default function ShaderFrame({ context, view, feature, dirty, refresh, actions, children }: {
  context: FeaturePageContext
  view: string
  feature: ReturnType<typeof useShaderFeature>
  dirty?: boolean
  refresh: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return <div className={`shader-workspace shader-view-${view}`} data-project-path={context.project?.path}>
    <div className="shader-toolbar"><span className="shader-object">{context.project?.name}{dirty ? ' · 未保存' : ''}</span><div className="shader-toolbar-actions">
      <button className="icon-button" title="刷新" disabled={feature.locked} onClick={refresh}>{feature.busy === 'loading' || feature.busy === 'refresh' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button>{actions}
    </div></div>
    {feature.error ? <div className="inline-error shader-message" role="alert"><CircleAlert size={16} />{feature.error}<button className="secondary-button compact" disabled={feature.locked} onClick={refresh}>重试</button></div> : feature.notice ? <div className="shader-message" role="status"><Check size={15} />{feature.notice}</div> : null}
    {children}
  </div>
}
