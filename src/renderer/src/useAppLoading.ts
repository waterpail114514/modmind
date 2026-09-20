import { useLayoutEffect } from 'react'

let cancelExit: (() => void) | undefined

/** Do not replace project content until the cover is opaque and has painted. */
export async function waitForAppLoadingCover(): Promise<void> {
  setAppLoading(true)
  const splash = document.getElementById('app-loading')
  if (!splash) return
  await new Promise<void>(resolve => {
    const check = (): void => {
      if (splash.hidden || splash.dataset.loading !== 'true') { resolve(); return }
      if (Number(getComputedStyle(splash).opacity) >= 1) {
        requestAnimationFrame(() => resolve())
      } else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}

export function setAppLoading(loading: boolean, immediate = false): void {
  cancelExit?.()
  cancelExit = undefined
  const splash = document.getElementById('app-loading')
  const root = document.getElementById('root')
  const setBusy = (busy: boolean): void => {
    if (!root) return
    root.inert = busy
    root.setAttribute('aria-busy', String(busy))
  }
  if (!splash) { setBusy(loading); return }
  if (loading) {
    splash.hidden = false
    if (!splash.matches(':popover-open')) splash.showPopover()
    splash.dataset.loading = 'true'
    setBusy(true)
    return
  }
  const finish = (): void => {
    cancelExit?.()
    cancelExit = undefined
    if (splash.matches(':popover-open')) splash.hidePopover()
    splash.hidden = true
    setBusy(false)
  }
  if (immediate || splash.hidden) { finish(); return }
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === splash && event.propertyName === 'opacity') finish()
  }
  // Keep input blocked until the fade ends, including when an exit is reversed.
  splash.addEventListener('transitionend', onEnd)
  const duration = Math.max(0, ...getComputedStyle(splash).transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)))
  const timeout = window.setTimeout(finish, duration + 50)
  cancelExit = () => {
    window.clearTimeout(timeout)
    splash.removeEventListener('transitionend', onEnd)
  }
  splash.dataset.loading = 'false'
}

/** Keep the HTML splash visible until the newly loaded workspace has painted. */
export function useAppLoading(loading: boolean): void {
  useLayoutEffect(() => {
    if (loading) {
      setAppLoading(true)
      return
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setAppLoading(false))
    })
    return () => cancelAnimationFrame(frame)
  }, [loading])
}
