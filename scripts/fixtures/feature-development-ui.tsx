import React from 'react'
import {createRoot} from 'react-dom/client'
import {useFeaturePlugins,featurePages,FeaturePluginRoutes} from '../../src/renderer/src/featurePlugins'

function Fixture(){
 const snapshot=useFeaturePlugins(),pages=featurePages(snapshot.modules)
 return <><h1>Local feature reload</h1><output data-testid="host-stays-mounted">Host fixture</output><FeaturePluginRoutes pages={pages} view="dev-live-smoke" routeData={{}} context={{project:null,darkMode:false,uiMode:'advanced',deviceState:{} as any,navigate:()=>{},hasPage:()=>true,openSettings:()=>{},filesChanged:()=>{},openFile:()=>{},createFile:()=>{},openProject:()=>{},sendToWorkbench:()=>{},setNotice:()=>{},exportArtifact:()=>{},projectBusy:false,saveBeforeRestore:async()=>{},projectRestored:()=>{}}}/></>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
