import { useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '../../../shared/types'
import type { ReleaseSettings } from '../../../shared/production'
import { reportClientFailure } from '../lib/clientFailure'
import { defaultRelease, RELEASE_SETTINGS_CHANGED, saveReleasePatch } from './releaseSettings'

// Each editor saves only fields changed in that editor; platform and export
// settings may have been changed since the retained publisher was last opened.
export function useReleaseDraft(project: ProjectInfo, active = true) {
  const [settings, setSettings] = useState(() => defaultRelease(project))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const patch = useRef<Partial<ReleaseSettings>>({})
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let request = 0
    const refresh = (): void => {
      const currentRequest = ++request
      setLoading(true)
      setError('')
      void window.modmind.production.release.getSettings().then(value => {
        if (!cancelled && currentRequest === request) setSettings({ ...value, ...patch.current })
      }).catch(reason => { if (!cancelled && currentRequest === request) setError(reportClientFailure(reason)) })
        .finally(() => { if (!cancelled && currentRequest === request) setLoading(false) })
    }
    refresh()
    window.addEventListener(RELEASE_SETTINGS_CHANGED, refresh)
    return () => { cancelled = true; window.removeEventListener(RELEASE_SETTINGS_CHANGED, refresh) }
  }, [project.path, active])
  const update = <K extends keyof ReleaseSettings>(key: K, value: ReleaseSettings[K]): void => {
    patch.current = { ...patch.current, [key]: value }
    setSettings(current => ({ ...current, [key]: value }))
  }
  const save = async (): Promise<ReleaseSettings> => {
    const saved = await saveReleasePatch(patch.current)
    patch.current = {}
    setSettings(saved)
    return saved
  }
  return { settings, loading, error, update, save, dirty: Object.keys(patch.current).length > 0 }
}
