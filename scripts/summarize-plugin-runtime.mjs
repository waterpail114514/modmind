import fs from 'node:fs/promises'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../test-results/plugin-runtime-matrix')
const records = new Map()
let soak
const reports = []
for (const file of ['remaining-report.json', 'report.json', ...(await fs.readdir(root)).filter(f => /^report-spigot-.*\.json$/.test(f)), 'spigot-report.json']) {
  try {
    const report = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))
    reports.push({ file, report })
  } catch {}
}
for (const { file, report } of reports.sort((a, b) => Date.parse(a.report.startedAt) - Date.parse(b.report.startedAt))) {
    for (const item of report.entries ?? []) {
      const platform = item.project?.loader ?? item.platform
      const version = item.project?.minecraftVersion ?? item.version
      const key = `${platform}:${version}`
      records.set(key, { ...item, platform, version, reportFile: file })
    }
    if (report.soak) soak = report.soak
}
if (soak?.passed) records.set(`${soak.project.loader}:${soak.project.minecraftVersion}`, { ...soak, platform: soak.project.loader, version: soak.project.minecraftVersion })
const entries = [...records.values()]
const summary = { at: new Date().toISOString(), passed: entries.filter(e => e.passed).length, compileOnly: entries.filter(e => e.compiled && !e.passed).length, failures: entries.filter(e => e.error).map(e => ({ platform: e.platform, version: e.version, error: e.error })), entries, soak }
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ passed: summary.passed, compileOnly: summary.compileOnly, failures: summary.failures }))
