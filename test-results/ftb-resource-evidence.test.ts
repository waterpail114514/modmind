import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import sharp from 'sharp'
import { archiveEntries, archiveRead } from '../src/main/ftbResourceArchive'
import { inspectFtbQuestIcon } from '../src/main/ftbquesticonservice'

test('read actual resource evidence', async () => {
  const projectPath = process.env.FTB_AUDIT_PROJECT!
  const project = { ...JSON.parse(await fs.readFile(path.join(projectPath, 'modmind.project.json'), 'utf8')), path: projectPath }
  const mods = path.join(projectPath, 'overrides/mods')
  for (const jar of (await fs.readdir(mods)).filter(name=>/GoetyRevelation|ramesses|pandora|twilightforest|^terramity/.test(name))) {
    const file = path.join(mods, jar)
    const entries = await archiveEntries(file)
    for (const entry of entries.filter(entry=>/eternal_watch.png$|seal_of_kadesh.png$|pandora_necklace/.test(entry))) {
      console.log('read-start', jar, entry)
      const buffer = await archiveRead(file, entry)
      console.log('read-done', buffer.length, entry.endsWith('.png') ? await sharp(buffer).metadata() : buffer.toString('utf8'))
    }
  }
  console.log('inspect-start')
  console.log(await inspectFtbQuestIcon(project, 'goety_revelation:eternal_watch'))
}, 120000)
