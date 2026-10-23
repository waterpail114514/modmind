/** Both URLs address the same public GitHub repository/ref/path; no version substitution. */
export function referenceDownloadSources(url: string): string[] {
  const match = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^/]+)\/(.+)$/.exec(url)
  return match ? [url, `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`] : [url]
}
