import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test, expect } from 'vitest'
import { readFtbQuestBook } from '../src/main/ftbQuestBookService'
import { ftbQuestResourceReport, inspectFtbQuestIcon } from '../src/main/ftbquesticonservice'
import { ftbIconDescriptor, ftbIconKey } from '../src/shared/ftbIcon'
import type { ProjectInfo } from '../src/shared/types'

test('read-only complete book resource audit', async () => {
  const projectPath = process.env.FTB_AUDIT_PROJECT!
  expect(projectPath).toBeTruthy()
  const project: ProjectInfo = { ...JSON.parse(await fs.readFile(path.join(projectPath, 'modmind.project.json'), 'utf8')), path: projectPath }
  const book = await readFtbQuestBook(project)
  const chapterFiles = (await fs.readdir(path.join(projectPath, book.root, 'chapters'))).filter(name => /\.(snbt|json5)$/.test(name))
  const occurrences: Array<{ kind: string; location: string; descriptor: unknown; key: string }> = []
  const invalid: unknown[] = []
  const collect = (raw: unknown, kind: string, location: string) => {
    if (!raw || typeof raw !== 'object') return
    for (const [key, value] of Object.entries(raw)) {
      if (['icon', 'item', 'fluid'].includes(key)) {
        const descriptor = ftbIconDescriptor(value)
        if (descriptor) occurrences.push({ kind, location: `${location}/${key}`, descriptor, key: ftbIconKey(descriptor) })
        else if (value) invalid.push({ kind, location: `${location}/${key}`, value })
      } else if (value && typeof value === 'object') collect(value, kind, `${location}/${key}`)
    }
  }
  for (const chapter of book.chapters) {
    collect({ icon: chapter.raw.icon }, 'chapter', chapter.source)
    for (const quest of chapter.quests) {
      collect({ icon: quest.raw.icon }, 'quest', `${chapter.source}/${quest.id}`)
      for (const task of quest.tasks) collect(task.raw, 'task', `${chapter.source}/${quest.id}/${task.id}`)
      for (const reward of quest.rewards) collect(reward.raw, 'reward', `${chapter.source}/${quest.id}/${reward.id}`)
    }
  }
  for (const table of book.rewardTables) collect(table.raw, 'reward-table', table.source)
  const unique = [...new Map(occurrences.map(row => [row.key, row.descriptor])).entries()]
  const start = performance.now()
  const measure = async ([key, descriptor]: [string, unknown]) => {
    const start = performance.now()
    const inspection = await inspectFtbQuestIcon(project, descriptor)
    const { icon, ...detail } = inspection
    return { key, descriptor, ms: performance.now() - start, quality: icon?.quality ?? 'unresolved', ...detail, image: icon ? { frameWidth: icon.frameWidth, frameHeight: icon.frameHeight, frameCount: icon.frameCount, animated: icon.animated } : null }
  }
  const sample = unique.filter(([, d]) => !ftbIconDescriptor(d)!.id.startsWith('minecraft:')).slice(0, 20)
  const cold = []
  for (const row of sample) cold.push(await measure(row))
  const warm = []
  for (const row of sample) warm.push(await measure(row))
  const results = []
  for (const row of unique) {
    results.push(await measure(row))
    if (results.length % 100 === 0) console.log('audit', results.length, '/', unique.length)
  }
  const report = { timestamp: new Date().toISOString(), projectPath, chapterFiles, chapters: book.chapters.length, quests: book.chapters.reduce((sum,c) => sum+c.quests.length,0), rewardTables: book.rewardTables.length, diagnostics: book.diagnostics, invalid, occurrences, unique: unique.length, resourceStack: await ftbQuestResourceReport(project), methodology: 'Local resources only; all chapter, quest, task, reward and reward-table item/icon/fluid fields. Complete descriptors deduplicated. Resolved means generated layers reconstructed, not comparison to game screenshot. Approximate geometry/color previews counted separately. Fresh module cold sample, OS cache not flushed; warm repeats same 20. No writes to project.', coldMs: cold.reduce((s,r)=>s+r.ms,0), warmMs: warm.reduce((s,r)=>s+r.ms,0), cold, warm, elapsedMs: performance.now()-start, counts: Object.fromEntries(['resolved','approximate','unresolved'].map(q=>[q,results.filter(r=>r.quality===q).length])), results }
  await fs.writeFile(path.resolve('test-results/ftb-icon-full-audit.json'), JSON.stringify(report, (_,v)=>typeof v === 'bigint' ? `${v}L` : v, 2))
  console.log(JSON.stringify({ chapters: report.chapters, quests: report.quests, unique: report.unique, counts: report.counts, coldMs: report.coldMs, warmMs: report.warmMs, elapsedMs: report.elapsedMs }))
  expect(book.diagnostics.filter(d=>d.code==='parse-failed')).toEqual([])
  expect(book.chapters.length).toBe(chapterFiles.length)
}, 1800000)
