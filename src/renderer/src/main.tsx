import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import AppBackground from './components/AppBackground'
import AppScrollbars from './components/AppScrollbars'
import { ExternalPluginOverlayRoot } from './components/ExternalPluginOverlayRoot'
import './theme-tokens.css'
import './styles.css'
import './workspace-chrome.css'
import './palette.css'
import './appearance.css'
import './theme'
import { diagnosticErrorPayload } from '../../shared/diagnostics'

// Capture in the page world: preload's isolated world cannot reliably read page Error objects.
const reportPageError = (reason: unknown, operation: string): void => {
  window.modmind.diagnostics.reportError(diagnosticErrorPayload(reason), operation)
}
window.addEventListener('error', event => reportPageError(event.error ?? event.message, 'page-error'))
window.addEventListener('unhandledrejection', event => reportPageError(event.reason, 'page-unhandled-rejection'))

const externalPluginOverlay = new URLSearchParams(window.location.search).has('pluginOverlay')
if (externalPluginOverlay) document.documentElement.classList.add('plugin-overlay-window-document')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppScrollbars />
      {!externalPluginOverlay && <AppBackground />}
      {externalPluginOverlay ? <ExternalPluginOverlayRoot /> : <App />}
    </AppErrorBoundary>
  </React.StrictMode>
)
