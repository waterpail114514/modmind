import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function nativeActions(host: NativeFeatureHost) {
  const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
  const handle = (channel: string, callback: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    actions[channel] = (input) => callback(host.event(), ...(input.args as any[]))
  }
  return { actions, handle }
}
