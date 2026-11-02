import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { FeaturePluginService, prepareFeaturePlugin } from './featurePluginService'

interface LocalBuild { id: string; archive: string; sha256: string }
interface LocalBuilds { version: 1; builds: LocalBuild[] }
const idPattern = /^[a-z][a-z0-9-]{0,63}$/

/** Consumes only completed local builds; activation and rollback stay in the normal plugin service. */
export class FeatureDevelopmentLoader {
  private timer?: ReturnType<typeof setInterval>
  private pending = false
  private stopped = false
  private loaded = new Map<string, string>()
  private reported = new Map<string, string>()
  constructor(private readonly root: string, private readonly plugins: FeaturePluginService, private readonly log: (message: string) => void = console.log) {}

  async start(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, 750)
    this.timer.unref()
  }
  stop(): void { this.stopped = true; clearInterval(this.timer) }

  async refresh(): Promise<void> {
    if (this.pending || this.stopped) return
    this.pending = true
    try {
      const raw = await fs.readFile(path.join(this.root, 'ready.json'), 'utf8')
      const state = JSON.parse(raw) as LocalBuilds
      if (state.version !== 1 || !Array.isArray(state.builds) || state.builds.length > 128) throw new Error('本地功能构建索引无效')
      for (const build of state.builds) {
        if (this.stopped) break
        if (!build || !idPattern.test(build.id) || !/^[a-f0-9]{64}$/.test(build.sha256)
          || typeof build.archive !== 'string' || build.archive !== `packages/${build.id}-${build.sha256}.zip`) throw new Error('本地功能构建路径无效')
        if (this.loaded.get(build.id) === build.sha256) continue
        const report = (message: string) => { if(this.reported.get(build.id) !== message) { this.reported.set(build.id, message); this.log(`[功能开发] ${build.id}: ${message}`) } }
        if (!this.plugins.canChange()) { report('等待当前任务结束后加载新构建'); continue }
        try {
          const file = path.join(this.root, build.archive)
          const relative = path.relative(await fs.realpath(this.root), await fs.realpath(file))
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('本地构建指向开发目录外部')
          if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('本地构建超过 64 MiB')
          const bytes = await fs.readFile(file)
          if (createHash('sha256').update(bytes).digest('hex') !== build.sha256) throw new Error('本地构建校验失败')
          const prepared = await prepareFeaturePlugin(file)
          if (prepared.manifest.id !== build.id) throw new Error('本地构建标识不匹配')
          if (prepared.manifest.dependencies?.some(id => !this.plugins.enabled(id))) { report('等待本地依赖完成加载'); continue }
          if (this.stopped || !this.plugins.canChange()) continue
          const current = this.plugins.list().find(record => record.id === build.id)
          if (current?.builtin) throw new Error('内置工作台请通过主程序开发流程更新')
          if (current && this.plugins.fingerprint(build.id) === createHash('sha256').update(JSON.stringify(prepared.manifest)).digest('hex')) {
            if(!current.enabled) await this.plugins.setEnabled(build.id, true)
          } else if (current) await this.plugins.update(prepared)
          else {
            await this.plugins.install(prepared)
            try { this.plugins.service(build.id) }
            catch(error) { await this.plugins.uninstall(build.id); throw error }
          }
          if(!this.plugins.enabled(build.id)) await this.plugins.setEnabled(build.id,true)
          this.loaded.set(build.id, build.sha256)
          this.reported.delete(build.id)
          this.log(`[功能开发] 已加载 ${build.id} ${prepared.manifest.version} (${build.sha256.slice(0, 8)})`)
        } catch (error) { report(`新构建未加载，保留当前版本：${error instanceof Error ? error.message : String(error)}`) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = String(error)
        if(this.reported.get('index') !== message) { this.reported.set('index',message); this.log(`[功能开发] ${message}`) }
      }
    } finally { this.pending = false }
  }
}
