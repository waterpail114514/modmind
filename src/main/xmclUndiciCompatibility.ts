import { errors } from 'undici'

/** XMCL's current file-transfer release still constructs Undici 6's error. */
export function ensureXmclUndiciCompatibility(): void {
  if ('ResponseStatusCodeError' in errors) return
  class ResponseStatusCodeError extends errors.ResponseError {
    constructor(message: string, statusCode: number, headers: Record<string, string>, body: string) {
      super(message, statusCode, { headers, body })
      Object.defineProperty(this, 'name', { value: 'ResponseStatusCodeError', configurable: true })
      Object.defineProperty(this, 'code', { value: 'UND_ERR_RESPONSE_STATUS_CODE', configurable: true })
    }
  }
  Object.defineProperty(errors, 'ResponseStatusCodeError', { value: ResponseStatusCodeError, configurable: true, writable: true })
}
