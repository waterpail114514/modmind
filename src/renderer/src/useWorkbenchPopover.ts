import { useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react'

/** Keep the existing button/form popovers usable with pointer and keyboard input. */
export function useWorkbenchPopover(
  root: RefObject<HTMLDivElement>, open: boolean, setOpen: Dispatch<SetStateAction<boolean>>,
  surfaceSelector: string, triggerSelector: string
): void {
  useEffect(() => {
    if (!open || !root.current) return
    const workbench = root.current
    const trigger = workbench.querySelector<HTMLElement>(triggerSelector)
    const inside = (target: EventTarget | null): boolean => target instanceof Node &&
      [trigger, ...workbench.querySelectorAll(surfaceSelector)].some(element => element?.contains(target))
    const closeOutside = (event: Event): void => { if (!inside(event.target)) setOpen(false) }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger?.focus()
    }
    // Keyboard users enter the surface immediately; pointer users retain their position.
    if (trigger?.matches(':focus-visible')) {
      workbench.querySelector<HTMLElement>(`${surfaceSelector} input, ${surfaceSelector} select, ${surfaceSelector} button:not(:disabled)`)?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    workbench.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
      workbench.removeEventListener('keydown', onKeyDown)
    }
  }, [root, open, setOpen, surfaceSelector, triggerSelector])
}
