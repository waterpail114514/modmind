// Reuse the application's actual preload API; replace only its IPC transport.
const g = window as any
export const contextBridge = { exposeInMainWorld: (name: string, value: unknown) => { g[name] = value } }
export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => g.__devIPC.invoke(channel, args),
  sendSync: (channel: string) => channel === 'app:platformInfo' ? g.__devPlatform : undefined,
  send: (channel: string, ...args: unknown[]) => { if (channel === 'sounds:renderComplete') void g.__devIPC.invoke(channel, args).catch((error: Error) => { g.__devErrors.push(error.message) }) },
  on: (channel: string, callback: (...args: unknown[]) => void) => g.__devIPC.on(channel, callback),
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => g.__devIPC.off(channel, callback)
}
export const webUtils = { getPathForFile: () => { throw new Error('预览中请使用导入文件操作') } }
