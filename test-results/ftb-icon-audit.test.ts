import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { test, expect } from 'vitest'
import { readFtbQuestBook } from '../src/main/ftbQuestBookService'
import { resolveFtbQuestIcon } from '../src/main/ftbquesticonservice'
import type { ProjectInfo } from '../src/shared/types'

test('real project read-only explicit icon audit', async () => {
  const started = performance.now()
  const projectPath = process.env.FTB_AUDIT_PROJECT!
  expect(projectPath).toBeTruthy()
  const project: ProjectInfo = { ...JSON.parse(await fs.readFile(path.join(projectPath, 'modmind.project.json'), 'utf8')), path: projectPath }
  const readStart = performance.now()
  const book = await readFtbQuestBook(project)
  const readMs = performance.now() - readStart
  const occurrences: Array<{ kind: string; chapterId: string; questId?: string; icon: string }> = []
  const emptyExplicit: unknown[] = []
  for (const chapter of book.chapters) {
    const documents = [{ kind: 'chapter', document: chapter }, ...chapter.quests.map(document => ({ kind: 'quest', document }))]
    for (const { kind, document } of documents) {
      if (!Object.prototype.hasOwnProperty.call(document.raw, 'icon')) continue
      const entry = { kind, chapterId: chapter.id, ...(kind === 'quest' ? { questId: document.id } : {}), icon: document.icon }
      if (document.icon) occurrences.push(entry)
      else emptyExplicit.push(entry)
    }
  }
  const ids = [...new Set(occurrences.map(o => o.icon))]
  const modIds = ids.filter(id => !id.toLowerCase().startsWith('minecraft:'))
  const sampleIds = modIds.slice(0, 20)
  type Row = { id: string; success: boolean; ms: number; error?: string }
  const measure = async (id: string): Promise<Row> => {
    const start = performance.now()
    try {
      const result = await resolveFtbQuestIcon(project, id)
      return { id, success: result !== null, ms: performance.now() - start }
    } catch (error) { return { id, success: false, ms: performance.now() - start, error: String(error) } }
  }
  const summarize = (rows: Row[]) => ({ count: rows.length, success: rows.filter(r => r.success).length, failure: rows.filter(r => !r.success).length, totalMs: rows.reduce((n, r) => n + r.ms, 0), failedIds: rows.filter(r => !r.success).map(r => r.id) })
  const report: any = {
    startedAt: new Date().toISOString(), projectPath, readMs, status: 'sampling',
    methodology: { deduplication: 'Exact nonempty normalized document.icon from explicit raw.icon only; no task/reward fallback', cold: 'First sequential sample batch in fresh Vitest module/process: first call builds index, later calls reuse it. OS disk cache is not flushed.', warm: 'Same 20 IDs repeated sequentially in same process', success: 'resolveFtbQuestIcon returns non-null (not visual or semantic correctness)', full: 'Sequential unique IDs; reuse first-pass sample rows and resolve remaining IDs with warm index', budgetMs: 600000 },
    chapters: book.chapters.length, quests: book.chapters.reduce((n,c) => n+c.quests.length,0), diagnostics: book.diagnostics,
    explicitOccurrences: occurrences.length, chapterOccurrences: occurrences.filter(o => o.kind === 'chapter').length, questOccurrences: occurrences.filter(o => o.kind === 'quest').length,
    emptyExplicit, uniqueIds: ids.length, uniqueModIds: modIds.length, uniqueMinecraftIds: ids.length-modIds.length,
    occurrences, coldSample: [], warmSample: [], results: []
  }
  const output = path.resolve('test-results/ftb-icon-audit.json')
  const save = async () => { report.elapsedMs = performance.now()-started; await fs.writeFile(output, JSON.stringify(report, null, 2)+'\n') }
  await save()
  for (const id of sampleIds) { const row = await measure(id); report.coldSample.push(row); console.log('cold', JSON.stringify(row)); await save() }
  for (const id of sampleIds) { const row = await measure(id); report.warmSample.push(row); console.log('warm', JSON.stringify(row)); await save() }
  report.coldSummary = summarize(report.coldSample)
  report.warmSummary = summarize(report.warmSample)
  report.estimatedFullRemainingMs = (report.warmSummary.totalMs / Math.max(1, sampleIds.length)) * (ids.length-sampleIds.length)
  report.results = [...report.coldSample]
  report.status = 'full-running'
  await save()
  console.log('sample-summary', JSON.stringify({ cold: report.coldSummary, warm: report.warmSummary, estimateMs: report.estimatedFullRemainingMs, totalIds: ids.length }))
  const fullStart = performance.now()
  for (const id of ids.filter(id => !sampleIds.includes(id))) {
    if (performance.now()-fullStart > 600000) { report.status = 'partial-budget-exceeded'; break }
    const row = await measure(id)
    report.results.push(row)
    if (report.results.length % 20 === 0) { console.log('full-progress', report.results.length, '/', ids.length); await save() }
  }
  report.fullRemainingWallMs = performance.now()-fullStart
  report.summary = summarize(report.results)
  report.failedIds = report.summary.failedIds
  report.untestedIds = ids.filter(id => !report.results.some((r: Row) => r.id === id))
  report.byKind = Object.fromEntries(['chapter', 'quest'].map(kind => {
    const kindIds = new Set(occurrences.filter(o => o.kind === kind).map(o => o.icon))
    return [kind, { unique: kindIds.size, ...summarize(report.results.filter((r: Row) => kindIds.has(r.id))) }]
  }))
  report.byNamespaceClass = Object.fromEntries(['minecraft', 'mod'].map(kind => [kind, summarize(report.results.filter((r: Row) => r.id.startsWith('minecraft:') === (kind === 'minecraft')))]))
  report.status = report.untestedIds.length ? report.status : 'complete'
  report.finishedAt = new Date().toISOString()
  await save()
  console.log('audit-summary', JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs, summary: report.summary, byKind: report.byKind, byNamespaceClass: report.byNamespaceClass }))
}, 1800000)
