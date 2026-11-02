import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactDiagnosticText } from '../shared/redactDiagnosticText'

const execute = promisify(execFile)
/** Read only this executable's recent application crash/WER records, with a short bounded query. */
export async function osCrashEvidence(executable: string): Promise<unknown> {
  if (process.platform !== 'win32') return { status: 'not-supported', required: 'Use local native crash dumps or the operating system crash report.' }
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; Get-WinEvent -FilterHashtable @{LogName="Application"; Id=1000,1001; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 100 -ErrorAction SilentlyContinue | Where-Object { $_.Message -and $_.Message.IndexOf($env:MODMIND_DIAGNOSTIC_EXECUTABLE, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 12 TimeCreated,Id,ProviderName,Message | ConvertTo-Json -Compress'
    ], { timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024, env: { ...process.env, MODMIND_DIAGNOSTIC_EXECUTABLE: executable } })
    return { status: 'collected', days: 7, events: stdout.trim() ? JSON.parse(redactDiagnosticText(stdout)) : [], scope: 'Matching executable path; absence does not prove a normal exit.' }
  } catch (error) { return { status: 'unavailable', error: redactDiagnosticText(String(error)).slice(0, 2000) } }
}
