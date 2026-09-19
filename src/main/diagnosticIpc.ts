import { ipcMain } from 'electron'
import { diagnosticJournal } from './diagnosticLog'
import { DiagnosticOperations } from './diagnosticOperations'

export const diagnosticIpcOperations = new DiagnosticOperations(diagnosticJournal)

export const diagnosticHandle: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, (event, ...args) => diagnosticIpcOperations.run('ipc', channel,
    { webContentsId: event.sender.id, osProcessId: event.sender.getOSProcessId() }, () => listener(event, ...args)))
}
