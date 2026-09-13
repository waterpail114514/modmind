import { useEffect, useState } from 'react'
import type { ModpackContentFeatures } from '../../../shared/modpackContentFeatures'

const empty: ModpackContentFeatures = { ftbQuests: false, patchouli: false }
const unknown: ModpackContentFeatures = { ftbQuests: true, patchouli: true }

export function useModpackContentFeatures(projectPath: string | undefined, revision: unknown): { features: ModpackContentFeatures; error: string } {
  const [state, setState] = useState<{ path: string; features: ModpackContentFeatures; error: string }>()
  useEffect(() => {
    if (!projectPath) return
    let current = true
    let pending = false
    let queued = false
    const refresh = (): void => {
      if (!current) return
      if (pending) { queued = true; return }
      pending = true
      void Promise.resolve().then(() => window.modmind.modpack.contentFeatures(projectPath)).then(features => {
        if (current) setState({ path: projectPath, features, error: '' })
      }).catch((error: unknown) => {
        if (!current) return
        const message = error instanceof Error ? error.message : String(error)
        const hint = /No handler registered|contentFeatures.*(?:not a function|undefined)/i.test(message)
          ? '内容识别接口尚未加载，请保存工作后完整重启 ModMind；刷新页面不会重启后台。'
          : '暂时无法识别内容工具，已保留入口。切回窗口或刷新内容列表后重试。'
        setState(previous => ({ path: projectPath, features: previous?.path === projectPath ? previous.features : unknown, error: hint }))
      }).finally(() => { pending = false; if (queued) { queued = false; refresh() } })
    }
    const unsubscribe = window.modmind.modpack.onModsChanged?.(changedPath => {
      if (changedPath.replaceAll('\\', '/') === projectPath.replaceAll('\\', '/')) refresh()
    })
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('modmind:content-changed', refresh)
    return () => { current = false; unsubscribe?.(); window.removeEventListener('focus', refresh); window.removeEventListener('modmind:content-changed', refresh) }
  }, [projectPath, revision])
  return state && state.path === projectPath ? state : { features: empty, error: '' }
}
