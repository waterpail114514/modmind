import React from 'react'
import { createRoot } from 'react-dom/client'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as dialogs from '../../src/renderer/src/components/InteractionDialogs'
import { themeCssVariables } from '../../src/shared/appTheme'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/palette.css'
import '../../src/renderer/src/workspace-chrome.css'
const host = window as any, root = createRoot(document.getElementById('workspace')!)
host.__modmindFeatureHost = { React, ReactDOM, jsxRuntime, dialogs }
let module: any
host.qaMount = async (visible = true) => {
  const project = await host.qa.project()
  ReactDOM.flushSync(() => root.render(visible ? React.createElement(module['modpack-datapacks'], { project, key: project.path, visible: true, navigate: () => {}, filesChanged: () => {}, darkMode: false }) : null))
}
host.qaTheme = (mode: 'light' | 'dark') => { for (const [key, value] of Object.entries(themeCssVariables('modmind', mode))) document.documentElement.style.setProperty(key, value); document.documentElement.dataset.theme = mode }
host.__modmindRegisterFeature = (_id: string, value: unknown) => { module = value; void host.qaMount() }
host.qaTheme('light')
document.body.classList.add('app-shell')
const script = document.createElement('script'); script.src = host.qa.rendererUrl; document.head.append(script)
