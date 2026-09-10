import { promises as fs } from 'node:fs'
import path from 'node:path'
import yauzl from 'yauzl'

const catalogs = new Map<string, Promise<Map<string, yauzl.Entry>>>()
const limit = 16 * 1024 * 1024
const nestedBuffers = new Map<string, Promise<Buffer>>()
let active = 0
const queue: Array<() => void> = []
async function bounded<T>(action: () => Promise<T>): Promise<T> {
  if (active >= 8) await new Promise<void>(resolve => queue.push(resolve))
  active++
  try { return await action() } finally { active--; queue.shift()?.() }
}
function open(file: string): Promise<yauzl.ZipFile> {
  const separator = file.lastIndexOf('!/')
  if (separator >= 0) {
    const buffer = fs.stat(file.split('!/')[0]).then(stat => {
      const key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      let request = nestedBuffers.get(key)
      if (!request) { request = archiveRead(file.slice(0, separator), file.slice(separator + 2)); nestedBuffers.set(key, request); while (nestedBuffers.size > 8) nestedBuffers.delete(nestedBuffers.keys().next().value!) }
      return request
    })
    return buffer.then(buffer => new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip!))))
  }
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip!)))
}
async function catalog(file: string): Promise<Map<string, yauzl.Entry>> {
  const stat = await fs.stat(file.split('!/')[0])
  const key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const cached = catalogs.get(key)
  if (cached) return cached
  const task = (async () => {
    const zip = await open(file)
    try {
      return await new Promise<Map<string, yauzl.Entry>>((resolve, reject) => {
        const entries = new Map<string, yauzl.Entry>()
        zip.on('error', reject)
        zip.on('entry', (entry: yauzl.Entry) => { if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry); zip.readEntry() })
        zip.on('end', () => resolve(entries))
        zip.readEntry()
      })
    } finally { zip.close() }
  })().catch(error => { catalogs.delete(key); throw error })
  catalogs.set(key, task)
  while (catalogs.size > 512) catalogs.delete(catalogs.keys().next().value!)
  return task
}
export async function archiveEntries(file: string): Promise<string[]> {
  if (file.includes('!/') || !(await fs.stat(file)).isDirectory()) return [...(await catalog(file)).keys()]
  const walk = async (root: string, prefix = ''): Promise<string[]> => {
    const result: string[] = []
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (entry.isDirectory()) result.push(...await walk(path.join(root, entry.name), `${name}/`))
      else if (entry.isFile()) result.push(name)
    }
    return result
  }
  return walk(file)
}
export async function archiveRead(file: string, name: string): Promise<Buffer> {
  if (name.split(/[\\/]/).some(part => part === '..') || path.isAbsolute(name)) throw new Error('Invalid resource path')
  if (!file.includes('!/') && (await fs.stat(file)).isDirectory()) {
    const target = path.join(file, name)
    if ((await fs.stat(target)).size > limit) throw new Error('Resource exceeds 16 MiB')
    return fs.readFile(target)
  }
  const entry = (await catalog(file)).get(name)
  if (!entry) throw new Error(`Resource missing: ${name}`)
  if (entry.uncompressedSize > limit) throw new Error('Resource exceeds 16 MiB')
  const zip = await open(file)
  return bounded(async () => {
    try {
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)))
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
        zip.on('error', reject)
      })
    } finally { zip.close() }
  })
}
