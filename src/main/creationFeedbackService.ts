import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { logDigestText, summarizeLog, isFailureFeedback, type CreationState, type CreationRequirement, type CreationCheck } from '../shared/creationFeedback'
import type { ProjectInfo } from '../shared/types'
import { SerialState } from './liveConfiguration'
import { projectSearchFiles } from './projectSearch'
import { artifactHash, buildInputFingerprint } from './creationBuildEvidence'
import { beginCreationTarget, finishCreationTarget, resolveCreationTarget } from './creationTargets'

const empty = (): CreationState => ({ revision: 0, requirements: [], logs: [], builds: [], checks: [], tasks: [] })
const lanes = new Map<string, SerialState>()
const targetSummary = (target: import('../shared/creationFeedback').CreationTargetRecord) => ({
  path: target.path, projectId: target.projectId, changedFiles: target.changedFiles?.slice(0, 100), changedFileCount: target.changedFiles?.length,
  artifacts: target.artifacts, missing: target.missing
})
export class CreationFeedbackService {
  readonly root: string
  constructor(readonly project: ProjectInfo) { this.root = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'creation') }
  async state(): Promise<CreationState> {
    return fs.readFile(path.join(this.root, 'state.json'), 'utf8').then(text => JSON.parse(text) as CreationState).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    })
  }
  async view(): Promise<CreationState> {
    const state = await this.state()
    return { ...state, tasks: state.tasks.slice(-30).map(task => ({ ...task, targets: task.targets?.map(target => ({ ...target, before: {}, changedFiles: target.changedFiles?.slice(0, 100) })), observations: task.observations.slice(0, 600), answer: task.answer?.slice(0, 600) })), builds: state.builds.slice(-10), checks: state.checks.slice(-20), logs: state.logs.slice(-10).map(log => ({ ...log, digest: { ...log.digest, observations: log.digest.observations.slice(0, 600), context: [], issues: log.digest.issues.slice(0, 20).map(issue => ({ ...issue, title: issue.title.slice(0, 240), stack: '' })) } })) }
  }
  async mutate(action: (state: CreationState) => void): Promise<CreationState> {
    const key = path.resolve(this.root)
    if (!lanes.has(key)) lanes.set(key, new SerialState())
    return lanes.get(key)!.run(async () => {
      const state = await this.state(); action(state); state.revision++
      await fs.mkdir(this.root, { recursive: true })
      const temporary = path.join(this.root, `${randomUUID()}.tmp`)
      await fs.writeFile(temporary, JSON.stringify(state), 'utf8')
      await fs.rename(temporary, path.join(this.root, 'state.json'))
      return state
    })
  }
  async evidence(text: string, source: string): Promise<{ id: string; prompt: string }> {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('单份证据超过 16 MiB，请分段导入')
    const id = createHash('sha256').update(source).update('\0').update(text).digest('hex')
    await fs.mkdir(path.join(this.root, 'evidence'), { recursive: true })
    await fs.writeFile(path.join(this.root, 'evidence', `${id}.txt`), text, { encoding: 'utf8', flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const digest = summarizeLog(text)
    if (digest.diagnostic) await this.mutate(state => {
      if (!state.logs.some(log => log.id === id)) state.logs.push({ id, source, createdAt: new Date().toISOString(), digest: { ...digest, issues: digest.issues.map(issue => ({ ...issue, stack: issue.stack.slice(0, 6_000) })), observations: digest.observations.slice(0, 8_000), context: digest.context.slice(0, 30) } })
      state.logs = state.logs.slice(-100)
    })
    return { id, prompt: logDigestText(digest, id) }
  }
  async read(id: string, start = 1, count = 100): Promise<{ text: string; totalLines: number }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('证据编号无效')
    const lines = (await fs.readFile(path.join(this.root, 'evidence', `${id}.txt`), 'utf8')).split(/\r?\n/)
    const first = Number.isFinite(start) ? Math.max(0, Math.floor(start) - 1) : 0
    const size = Number.isFinite(count) ? Math.max(1, Math.min(300, Math.floor(count))) : 100
    return { text: lines.slice(first, first + size).map((line, index) => `${first + index + 1}: ${line}`).join('\n').slice(0, 40_000), totalLines: lines.length }
  }
  async begin(id: string, request: string, conversationId?: string): Promise<string> {
    const evidence = await this.evidence(request, 'user')
    await this.mutate(state => {
      if (!state.tasks.some(task => task.id === id)) state.tasks.push({ id, conversationId, requestEvidence: evidence.id, observations: summarizeLog(request).observations.slice(0, 8_000), createdAt: new Date().toISOString(), failure: isFailureFeedback(request), latestBuildIdAtRequest: state.builds.at(-1)?.id })
    })
    return evidence.prompt
  }
  async requirement(revision: number, value: CreationRequirement): Promise<CreationState> {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 256 || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000 || typeof value.sourceMessageId !== 'string' || !value.sourceMessageId || !['active', 'superseded', 'cancelled'].includes(value.status) || !['user', 'assistant'].includes(value.author) || (value.replaces !== undefined && typeof value.replaces !== 'string')) throw new Error('要求缺少来源、内容或有效状态')
    return this.mutate(state => {
      if (revision !== state.revision) throw new Error('记录已更新，请刷新后修改')
      if (!state.tasks.some(task => task.id === value.sourceMessageId)) throw new Error('要求来源必须是当前项目已记录的用户消息')
      if (value.replaces) {
        const previous = state.requirements.find(item => item.id === value.replaces)
        if (!previous || previous.id === value.id) throw new Error('被替代的要求不存在')
        previous.status = 'superseded'
      }
      const index = state.requirements.findIndex(item => item.id === value.id)
      const clean: CreationRequirement = { id: value.id, text: value.text.trim(), sourceMessageId: value.sourceMessageId, status: value.status, author: value.author, ...(value.replaces ? { replaces: value.replaces } : {}) }
      if (index < 0) state.requirements.push(clean); else state.requirements[index] = clean
    })
  }
  async built(artifact: { path: string }): Promise<void> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(artifact.path)) hash.update(chunk)
    const configuration = createHash('sha256')
    for (const file of (await projectSearchFiles(this.project)).files.filter(file => /\.(?:ya?ml|toml|properties|json|gradle|kts)$/.test(file))) {
      const absolute = path.join(this.project.path, file)
      if ((await fs.stat(absolute)).size <= 1024 * 1024) configuration.update(file).update(await fs.readFile(absolute))
    }
    const sha256 = hash.digest('hex')
    await this.mutate(state => { state.builds.push({ id: randomUUID(), path: artifact.path, sha256, createdAt: new Date().toISOString(), configurationHash: configuration.digest('hex'), status: 'built' }); state.builds = state.builds.slice(-60) })
  }
  async build<T extends { path: string }>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const id = randomUUID()
    // Fingerprint failure must not prevent an otherwise valid build; it prevents certification.
    const before = signal?.aborted ? undefined : await buildInputFingerprint(this.project.path).catch(() => undefined)
    await this.mutate(state => { state.builds.push({ id, path: '', sourceHash: before, configurationHash: '', createdAt: new Date().toISOString(), status: 'running' }); state.builds = state.builds.slice(-60) })
    try {
      signal?.throwIfAborted()
      const artifact = await run()
      const sha256 = await artifactHash(artifact.path)
      const after = await buildInputFingerprint(this.project.path).catch(() => undefined)
      await this.mutate(state => {
        const build = state.builds.find(item => item.id === id)!
        Object.assign(build, { path: artifact.path, sha256, status: before && before === after ? 'built' : 'stale', detail: before && before === after ? undefined : '构建期间输入变化或完整指纹不可用，结果需要重新核对' })
      })
      return artifact
    } catch (error) {
      await this.mutate(state => { const build = state.builds.find(item => item.id === id)!; build.status = signal?.aborted ? 'cancelled' : 'failed'; build.detail = String(error).slice(0, 2000) })
      throw error
    }
  }
  async verifyLatestBuild(): Promise<boolean> {
    const build = (await this.state()).builds.at(-1)
    if (!build || build.status !== 'built' || !build.sourceHash || !build.sha256) return false
    const valid = await Promise.all([buildInputFingerprint(this.project.path), artifactHash(build.path)])
      .then(([source, artifact]) => source === build.sourceHash && artifact === build.sha256).catch(() => false)
    if (!valid) await this.mutate(state => { const stored = state.builds.find(item => item.id === build.id); if (stored) stored.status = 'stale' })
    return valid
  }
  async delivery(taskId: string, value: import('../shared/creationFeedback').CreationTaskRecord['delivery']): Promise<CreationState> {
    if (!value || !['partial', 'awaiting-verification', 'blocked', 'complete', 'cancelled'].includes(value.status)
      || !Array.isArray(value.remaining) || value.remaining.length > 30 || value.remaining.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)
      || !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 30 || value.evidenceIds.some(item => typeof item !== 'string')
      || (value.status === 'complete' && value.remaining.length)) throw new Error('交付状态或剩余工作无效')
    return this.mutate(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (value.status === 'complete' && task.targets?.some(target => target.missing?.length)) throw new Error('交付目标仍有缺失输入，不能标记完整交付')
      if (value.evidenceIds.some(id => !state.builds.some(item => item.id === id) && !state.checks.some(item => item.id === id) && !state.logs.some(item => item.id === id))) throw new Error('交付证据不存在')
      task.delivery = { status: value.status, remaining: [...value.remaining], evidenceIds: [...value.evidenceIds] }
    })
  }
  async target(taskId: string, requested: string, artifacts?: string[]): Promise<unknown> {
    const task = (await this.state()).tasks.find(item => item.id === taskId)
    if (!task) throw new Error('任务不存在')
    const absolute = await resolveCreationTarget(this.project, requested)
    const identity = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const existing = task.targets?.find(target => identity(target.path) === identity(absolute))
    const target = existing ? await finishCreationTarget(this.project, existing, artifacts) : await beginCreationTarget(this.project, requested)
    if (!existing && artifacts?.length) throw new Error('先登记目标基线，再修改并关联产物')
    await this.mutate(state => { const stored = state.tasks.find(item => item.id === taskId)!; stored.targets = [...(stored.targets ?? []).filter(item => item.path !== target.path), target] })
    const evidence = await this.evidence(JSON.stringify({ ...target, before: undefined }), 'target-changes')
    return { ...targetSummary(target), evidenceId: evidence.id }
  }
  async finishTargets(taskId: string): Promise<Array<Omit<import('../shared/creationFeedback').CreationTargetRecord, 'before'>>> {
    const task = (await this.state()).tasks.find(item => item.id === taskId)
    if (!task?.targets?.length) return []
    const targets = await Promise.all(task.targets.map(async target => {
      try { return await finishCreationTarget(this.project, target) }
      catch (error) { return { ...target, missing: [String(error)], changedFiles: undefined } }
    }))
    await this.mutate(state => {
      const stored = state.tasks.find(item => item.id === taskId)!
      stored.targets = targets
      if (targets.some(target => target.missing?.length) && stored.delivery?.status === 'complete') stored.delivery = { ...stored.delivery, status: 'blocked', remaining: targets.flatMap(target => target.missing ?? []) }
    })
    return targets.map(({ before: _before, ...target }) => target)
  }
  async check(check: Omit<CreationCheck, 'id' | 'createdAt'>): Promise<void> {
    await this.mutate(state => { state.checks.push({ ...check, id: randomUUID(), createdAt: new Date().toISOString() }); state.checks = state.checks.slice(-150) })
  }
  async recover(latest: string, conversationId?: string, legacyHistory?: string): Promise<string> {
    const state = await this.state()
    const tasks = state.tasks.filter(task => task.conversationId === conversationId)
    const sourceIds = new Set(tasks.map(task => task.id))
    const earlier = tasks.slice(0, -5).map(t => ({ id: t.id, evidence: t.requestEvidence }))
    const unfinished = tasks.filter(task => task.delivery ? !['complete', 'cancelled'].includes(task.delivery.status) : !task.answer).map(task => ({ id: task.id, evidence: task.requestEvidence, delivery: task.delivery, targets: task.targets?.map(targetSummary), hypothesis: task.hypothesis, latestBuildIdAtRequest: task.latestBuildIdAtRequest }))
    const pendingIndex = unfinished.length > 10 ? await this.evidence(JSON.stringify(unfinished), 'pending-deliveries') : undefined
    const index = earlier.length ? await this.evidence(JSON.stringify(earlier), 'history-index') : undefined
    const legacy = legacyHistory?.trim() ? await this.evidence(legacyHistory, 'legacy-conversation') : undefined
    return [
      '恢复上下文：以下记录只描述已保存事实。要求以最新用户修改为准，助手结论不等于实测。',
      `当前要求：${JSON.stringify(state.requirements.filter(r => r.status === 'active' && sourceIds.has(r.sourceMessageId)))}`,
      `最近产物：${JSON.stringify(state.builds.slice(-2))}`,
      `验证：${JSON.stringify(state.checks.slice(-8))}`,
      `近期任务：${JSON.stringify(tasks.slice(-5).map(task => ({ ...task, targets: task.targets?.map(targetSummary), observations: task.observations.slice(0, 2000), answer: task.answer?.slice(0, 2000) })))}`,
      `未完成交付或未记录回答的任务（助手记录不等于用户验收）：${JSON.stringify(unfinished.slice(-10))}`,
      ...(pendingIndex ? [`更早未完成交付索引：${pendingIndex.id}`] : []),
      `早期请求索引证据：${index?.id ?? '无'}；旧会话/分支记录证据：${legacy?.id ?? '无'}。未完成的旧任务与被修改的条件需按范围查证，不能假设遗失。`,
      '需要历史细节时使用 modmind_creation_context read 读取证据，禁止将全部日志再读入。',
      `最新请求：\n${latest}`
    ].join('\n\n')
  }
}
