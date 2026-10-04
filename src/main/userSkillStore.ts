import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import type { UserSkill, UserSkillDocument, UserSkillSaveInput } from '../shared/userSkills'
import { WORKBENCH_SKILL_ROUTES } from './workbenchSkillPolicy'

const MAX_CONTENT = 256 * 1024
const reserved = new Set<string>(WORKBENCH_SKILL_ROUTES.map(([name]) => name))

function skillName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) throw new Error('Skill 名称须为 1–64 位小写字母、数字或单连字符')
  if (reserved.has(value)) throw new Error('该名称由内置 skill 使用，请换一个名称')
  return value
}

export function parseUserSkill(content: string): { name: string; description: string } {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CONTENT) throw new Error('SKILL.md 不能超过 256 KiB')
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!header) throw new Error('SKILL.md 须包含 YAML 头部的 name 和 description')
  let metadata: Record<string, unknown>
  try { metadata = parse(header[1], { maxAliasCount: 10 }) } catch { throw new Error('SKILL.md 的 YAML 头部格式无效') }
  if (!metadata || typeof metadata !== 'object') throw new Error('SKILL.md 头部格式无效')
  const name = skillName(metadata.name)
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) throw new Error('description 须为 1–1024 个字符')
  if (!content.slice(header[0].length).trim()) throw new Error('请填写 skill 的指令正文')
  return { name, description: metadata.description.trim() }
}

const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex')

async function readSkillFile(file: string): Promise<string> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > MAX_CONTENT) throw new Error('SKILL.md 须为不超过 256 KiB 的普通文件')
  return fs.readFile(file, 'utf8')
}

/** App-owned copies keep imports offline and independent of the original folder. */
export class UserSkillStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string) {}

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async disabled(): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(this.root, 'disabled.json'), 'utf8'))
      if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) throw new Error('Skill 启停记录格式无效')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async writeDisabled(names: string[]): Promise<void> {
    const temporary = path.join(this.root, `.disabled-${randomUUID()}.tmp`)
    try { await fs.writeFile(temporary, JSON.stringify(names), 'utf8'); await fs.rename(temporary, path.join(this.root, 'disabled.json')) }
    finally { await fs.rm(temporary, { force: true }) }
  }

  async read(name: string): Promise<UserSkillDocument> {
    const content = await readSkillFile(path.join(this.root, skillName(name), 'SKILL.md'))
    const metadata = parseUserSkill(content)
    if (metadata.name !== name) throw new Error('Skill 名称须与目录名一致')
    return { ...metadata, content, revision: revisionOf(content), enabled: !(await this.disabled()).includes(name) }
  }

  async list(): Promise<UserSkill[]> {
    await fs.mkdir(this.root, { recursive: true })
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    return Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
      const { content: _content, ...item } = await this.read(entry.name)
      return item
    }))
  }

  save(input: UserSkillSaveInput): Promise<UserSkillDocument> {
    return this.mutate(async () => {
      const metadata = parseUserSkill(input.content)
      await fs.mkdir(this.root, { recursive: true })
      if (input.name) {
        const existing = await this.read(input.name)
        if (metadata.name !== existing.name) throw new Error('编辑时不能改变 name；请新建另一个 skill')
        if (input.revision !== existing.revision) throw new Error('Skill 已被其他窗口修改，请重新打开后再保存')
        const temporary = path.join(this.root, existing.name, `.SKILL-${randomUUID()}.tmp`)
        try { await fs.writeFile(temporary, input.content, 'utf8'); await fs.rename(temporary, path.join(this.root, existing.name, 'SKILL.md')) }
        finally { await fs.rm(temporary, { force: true }) }
      } else {
        const directory = path.join(this.root, metadata.name)
        try { await fs.mkdir(directory) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('已存在同名 skill，请打开它进行编辑')
          throw error
        }
        try { await fs.writeFile(path.join(directory, 'SKILL.md'), input.content, 'utf8') }
        catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
      }
      return this.read(metadata.name)
    })
  }

  import(source: string): Promise<UserSkillDocument> {
    return this.mutate(async () => {
      const stat = await fs.lstat(source)
      if (stat.isSymbolicLink()) throw new Error('不支持导入符号链接')
      const directory = stat.isDirectory() ? source : path.dirname(source)
      if (!stat.isDirectory() && path.basename(source) !== 'SKILL.md') throw new Error('请选择 SKILL.md 或包含它的目录')
      const content = await readSkillFile(path.join(directory, 'SKILL.md'))
      const metadata = parseUserSkill(content)
      let bytes = 0, files = 0
      const inspect = async (folder: string): Promise<void> => {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const target = path.join(folder, entry.name)
          const info = await fs.lstat(target)
          if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('Skill 目录不能包含符号链接或特殊文件')
          if (++files > 1000 || (bytes += info.isFile() ? info.size : 0) > 64 * 1024 * 1024) throw new Error('Skill 目录不能超过 1000 项或 64 MiB')
          if (info.isDirectory()) await inspect(target)
        }
      }
      if (stat.isDirectory()) await inspect(directory)
      await fs.mkdir(this.root, { recursive: true })
      const target = path.join(this.root, metadata.name)
      if (await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('已存在同名 skill，请打开它进行编辑')
      const temporary = path.join(this.root, `.import-${randomUUID()}`)
      try {
        if (stat.isDirectory()) {
          await fs.cp(directory, temporary, { recursive: true, dereference: false, filter: async file => {
            if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Skill 目录不能包含符号链接')
            return true
          } })
        } else {
          await fs.mkdir(temporary)
          await fs.writeFile(path.join(temporary, 'SKILL.md'), content, 'utf8')
        }
        parseUserSkill(await readSkillFile(path.join(temporary, 'SKILL.md')))
        await fs.rename(temporary, target)
      } finally { await fs.rm(temporary, { recursive: true, force: true }) }
      return this.read(metadata.name)
    })
  }

  setEnabled(name: string, enabled: boolean): Promise<UserSkillDocument> {
    return this.mutate(async () => {
      if (typeof enabled !== 'boolean') throw new Error('enabled 须为布尔值')
      await this.read(name)
      const disabled = new Set(await this.disabled())
      if (enabled) disabled.delete(name); else disabled.add(name)
      await this.writeDisabled([...disabled])
      return this.read(name)
    })
  }

  remove(name: string, revision: string): Promise<void> {
    return this.mutate(async () => {
      if ((await this.read(name)).revision !== revision) throw new Error('Skill 已被修改，请重新打开后再移除')
      await fs.rm(path.join(this.root, skillName(name)), { recursive: true })
      await this.writeDisabled((await this.disabled()).filter(item => item !== name))
    })
  }

  snapshot(target: string): Promise<UserSkill[]> {
    return this.mutate(async () => {
      const destination = path.resolve(target), source = path.resolve(this.root)
      const relative = path.relative(source, destination)
      if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative) || source.startsWith(`${destination}${path.sep}`)) throw new Error('Skill 副本目录须与存储目录分离')
      const skills = (await this.list()).filter(item => item.enabled)
      await fs.rm(destination, { recursive: true, force: true })
      await fs.mkdir(destination, { recursive: true })
      for (const skill of skills) await fs.cp(path.join(this.root, skill.name), path.join(destination, skill.name), { recursive: true, filter: async file => {
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Skill 目录不能包含符号链接')
        return true
      } })
      return skills
    })
  }
}

export async function readSkillResource(root: string, name: string, relativePath = 'SKILL.md'): Promise<{ path: string; content: string }> {
  const directory = path.join(root, skillName(name))
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => part === '..' || part.includes(':'))) throw new Error('只能读取当前 skill 内的相对路径')
  const target = path.resolve(directory, relativePath)
  const actual = await fs.realpath(target)
  const scope = await fs.realpath(directory)
  if (!actual.startsWith(`${scope}${path.sep}`)) throw new Error('Skill 资源路径越界')
  const stat = await fs.stat(actual)
  if (!stat.isFile() || stat.size > MAX_CONTENT) throw new Error('只能读取不超过 256 KiB 的文本资源')
  const content = await fs.readFile(actual, 'utf8')
  if (content.includes('\0')) throw new Error('该 Skill 资源不是文本文件')
  return { path: relativePath, content }
}
