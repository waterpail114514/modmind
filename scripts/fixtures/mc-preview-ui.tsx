import React from 'react'
import { createRoot } from 'react-dom/client'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as dialogs from '../../src/renderer/src/components/InteractionDialogs'
import { themeCssVariables } from '../../src/shared/appTheme'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/palette.css'

const host = window as any
host.__modmindFeatureHost = {React,ReactDOM,jsxRuntime,dialogs}
const root = createRoot(document.getElementById('workspace')!)
let module: any, project: any
host.qaMount = async (visible = true) => {
  project = await host.qa.project()
  ReactDOM.flushSync(()=>root.render(visible ? React.createElement(module.PreviewWorkspace, {key:project.path,project,visible:true,hasPage:()=>true,navigate:()=>{},filesChanged:()=>{}}) : null))
}
host.qaTheme = (mode: 'light'|'dark', preset='modmind') => {
  for(const [key,value] of Object.entries(themeCssVariables(preset,mode))) document.documentElement.style.setProperty(key,value)
  document.documentElement.dataset.theme = mode
}
host.__modmindRegisterFeature = (_id:string,value:any) => {module=value;void host.qaMount()}
host.qaTheme('light')
const script=document.createElement('script');script.src=host.qa.rendererUrl;document.head.append(script)
