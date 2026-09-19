import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WORKBENCH_SKILL_ROUTES } from './workbenchSkillPolicy'

/** Only prune known bundled workflows; never remove user-authored skills. */
export async function syncWorkbenchSkills(sourceDirectory: string, targetRoot: string, names?: readonly string[]): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true })
  const known = new Set<string>(WORKBENCH_SKILL_ROUTES.map(([name]) => name))
  if (names) {
    for (const name of known) {
      if (!names.includes(name)) await fs.rm(path.join(targetRoot, name), { recursive: true, force: true })
    }
  }
  for (const entry of await fs.readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || names && known.has(entry.name) && !names.includes(entry.name)) continue
    await fs.cp(path.join(sourceDirectory, entry.name), path.join(targetRoot, entry.name), { recursive: true, force: true })
  }
}
