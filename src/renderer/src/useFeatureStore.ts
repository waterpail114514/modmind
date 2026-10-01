import { useEffect, useSyncExternalStore } from 'react'
import type { FeatureStoreSnapshot } from '../../shared/featureStore'

let snapshot: FeatureStoreSnapshot = { entries: [], checking: false, cached: false }
const listeners = new Set<() => void>()
let subscribers = 0, unsubscribe: (() => void) | undefined, interval: ReturnType<typeof setInterval> | undefined
const publish = (value: FeatureStoreSnapshot): void => { snapshot=value; listeners.forEach(listener=>listener()) }
export function useFeatureStore(): FeatureStoreSnapshot {
  useEffect(()=>{
    if(subscribers++===0){
      unsubscribe=window.modmind.featurePlugins.onStoreChanged(publish)
      void window.modmind.featurePlugins.store().then(publish).catch(error=>publish({...snapshot,error:String(error)}))
      interval=setInterval(()=>{void window.modmind.featurePlugins.refreshStore().then(publish).catch(()=>undefined)},30*60*1000)
    }
    return()=>{if(--subscribers===0){unsubscribe?.();unsubscribe=undefined;clearInterval(interval)}}
  },[])
  return useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback)},()=>snapshot)
}
