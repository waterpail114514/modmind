import { lstatSync } from 'node:fs'
import path from 'node:path'
import extractZip from 'extract-zip'
import yauzl from 'yauzl'

function checkTarget(root: string, fileName = ''): string {
  const relative = fileName.replaceAll('\\', '/')
  // Reject traversal before normalization; removing '.' must never hide '..'.
  if (relative && (/^[\/]/.test(relative) || /[\0:]/.test(relative) || relative.split('/').includes('..'))) {
    throw new Error(`Unsafe ZIP path: ${fileName}`)
  }
  const segments = relative.split('/').filter(part => part && part !== '.')
  const normalized = segments.join('/')
  const target = path.resolve(root, ...segments)
  const inside = path.relative(root, target)
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`Unsafe ZIP path: ${fileName}`)
  let current = root
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment)
    const stat = (() => { try { return lstatSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } })()
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink > 1)) throw new Error(`ZIP destination contains a link: ${fileName || root}`)
  }
  return normalized
}

function checkEntry(root: string, entry: yauzl.Entry): void {
  const kind = (entry.externalFileAttributes >>> 16) & 0o170000
  if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) throw new Error(`ZIP contains an unsupported link or special file: ${entry.fileName}`)
  const directory = kind === 0o040000 || entry.fileName.replaceAll('\\', '/').endsWith('/')
  const normalized = checkTarget(root, entry.fileName)
  // A root-only entry cannot name an output file; extract-zip also rejects root directory entries.
  if (!normalized) throw new Error(`Unsafe ZIP path: ${entry.fileName}`)
  // extract-zip and its caller's callback must use the same checked path.
  entry.fileName = directory ? `${normalized}/` : normalized
}

/** Reject linked archive entries and existing linked destinations before extract-zip creates directories. */
export default async function safeExtractZip(archive: string, options: extractZip.Options): Promise<void> {
  if (!path.isAbsolute(options.dir)) throw new Error('ZIP destination must be absolute')
  const root = path.resolve(options.dir)
  checkTarget(root)
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('Could not open ZIP')); return }
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => {
        try { checkEntry(root, entry); zip.readEntry() }
        catch (error) { zip.close(); reject(error) }
      })
      zip.readEntry()
    })
  })
  await extractZip(archive, { ...options, dir: root, onEntry(entry, zip) { checkEntry(root, entry); options.onEntry?.(entry, zip) } })
}
