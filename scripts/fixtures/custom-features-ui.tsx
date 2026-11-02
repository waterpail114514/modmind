import React from 'react'
import { createRoot } from 'react-dom/client'
import FeaturesPage from '../../src/renderer/src/components/FeaturesPage'
import { themeCssVariables } from '../../src/shared/appTheme'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/palette.css'
import '../../src/renderer/src/workspace-chrome.css'
const host = window as any
host.qaTheme = (mode: 'light' | 'dark') => { for (const [key, value] of Object.entries(themeCssVariables('modmind', mode))) document.documentElement.style.setProperty(key, value); document.documentElement.dataset.theme = mode; document.body.classList.toggle('dark-mode', mode === 'dark') }
document.body.classList.add('app-shell'); host.qaTheme('light')
void host.qa.project().then((project: any) => createRoot(document.getElementById('workspace')!).render(<FeaturesPage project={project} uiMode="advanced" onOpen={() => {}} onSettings={() => {}} />))
