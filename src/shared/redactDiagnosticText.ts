export function redactDiagnosticText(value: string): string {
  return value
    .replace(/("(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret|cookie|credential)\s*[:=]\s*)(\[REDACTED(?:_API_KEY)?\]|"[^"]*"|'[^']*'|[^\s,}\]&#]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g, '[REDACTED_API_KEY]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|code)=)[^&#\s]+/gi, '$1[REDACTED]')
}
