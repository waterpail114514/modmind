export function getMediaDisplayUrl(url: string | null | undefined) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return '';
  }

  return normalizedUrl;
}
