import { describeClientFailure } from '../../../shared/clientFailure'
import { diagnosticErrorPayload } from '../../../shared/diagnostics'

/** Use at catch boundaries, never during render: retain evidence before presenting it. */
export function reportClientFailure(error: unknown): string {
  try {
    window.modmind?.diagnostics.reportError(diagnosticErrorPayload(error), 'handled-error')
  } catch { /* Reporting must not prevent the error from being shown. */ }
  return describeClientFailure(error)
}
