import { scrollbarStyles } from '../../../shared/scrollbars'
import { forwardRef, type HTMLAttributes } from 'react'

const styles = scrollbarStyles() + `
.scroll-area { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
body .sidebar.collapsed .sidebar-nav, body .pack-content-targets, body .settings-index { scrollbar-width: none !important; }
body .sidebar.collapsed .sidebar-nav::-webkit-scrollbar, body .pack-content-targets::-webkit-scrollbar, body .settings-index::-webkit-scrollbar { display: none !important; }
`

export default function AppScrollbars(): React.JSX.Element {
  return <style id="modmind-scrollbars">{styles}</style>
}

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollArea({ className = '', ...props }, ref) {
  return <div {...props} ref={ref} className={`scroll-area ${className}`} />
})
