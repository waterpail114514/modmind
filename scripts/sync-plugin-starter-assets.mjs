import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'resources/server-plugin-starters')
const upstream = JSON.parse(await fs.readFile(path.join(source, 'upstream.json'), 'utf8'))
for (const entry of upstream.files) {
  const content = await fs.readFile(path.join(source, entry.file))
  if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error(`Upstream starter changed: ${entry.file}`)
}
let module = '// Generated from pinned Minecraft Development templates; run scripts/sync-plugin-starter-assets.mjs.\n'
for (const [name, file] of [['BUKKIT_STARTER','bukkit.java.ft'],['VELOCITY3_STARTER','velocity3.java.ft'],['STARTER_LICENSE','LICENSE-LGPL.txt'],['STARTER_GPL','LICENSE-GPL.txt']]) module += `export const ${name} = ${JSON.stringify(await fs.readFile(path.join(source, file), 'utf8'))}\n`
await fs.writeFile(path.join(root, 'src/main/serverPluginStarters.ts'), module)
