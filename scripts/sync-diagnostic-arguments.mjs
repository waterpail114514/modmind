import ts from 'typescript'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export async function diagnosticArgumentContracts() {
  const contracts = {}
  const files = ['src/main/index.ts', ...(await readdir(path.join(root, 'feature-plugins'))).map(id => `feature-plugins/${id}/main.ts`)]
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(path.join(root, file), 'utf8').catch(() => ''), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'diagnosticHandle' && ts.isStringLiteral(node.arguments[0]) && (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))) {
        const names = node.arguments[1].parameters.slice(1).map((parameter, index) => ts.isIdentifier(parameter.name) ? parameter.name.text : `argument${index}`)
        if (names.length) contracts[node.arguments[0].text] = names
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return Object.fromEntries(Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b)))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(root, 'src/main/diagnosticIpcArguments.json')
  const expected = JSON.stringify(await diagnosticArgumentContracts(), null, 2) + '\n'
  if (process.argv.includes('--write')) await writeFile(target, expected)
  else if ((await readFile(target, 'utf8')).replaceAll('\r\n', '\n') !== expected) throw new Error('IPC diagnostic argument contracts are stale. Run node scripts/sync-diagnostic-arguments.mjs --write')
  console.log('Diagnostic IPC argument contracts verified')
}
