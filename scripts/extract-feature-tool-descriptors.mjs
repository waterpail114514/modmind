import ts from 'typescript'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const parse = (file, contents) => ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function initializers(source) {
  const values = new Map()
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) values.set(node.name.text, node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}
const shared = parse('imageStudioRequest.ts', await readFile(path.join(root, 'src/shared/imageStudioRequest.ts'), 'utf8'))
const schemas = initializers(shared)
const schema = name => {
  let expression = schemas.get(name)
  if (ts.isAsExpression(expression)) expression = expression.expression
  return runInNewContext('(' + expression.getText(shared) + ')')
}
const source = parse('externalAgents.ts', await readFile(path.join(root, 'src/main/externalAgents.ts'), 'utf8'))
const initializer = initializers(source).get('MCP_SERVER_SOURCE')
const server = runInNewContext(initializer.getText(source), {
  imageGenerationInputSchema: schema('imageGenerationInputSchema'), perfectPixelInputSchema: schema('perfectPixelInputSchema')
})
const definitions = runInNewContext(server.slice(server.indexOf('const readOnlyLocal'), server.indexOf('const input = readline')) + '\ntools;', {})
const serverAst = ts.createSourceFile('server.mjs', server, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const actions = initializers(serverAst).get('actions')
const mappings = runInNewContext('(' + actions.getText(serverAst) + ')')
const output = path.join(root, 'feature-plugin-dist')
await mkdir(output, { recursive: true })
await writeFile(path.join(output, 'legacy-tool-descriptors.json'), JSON.stringify(definitions.map(tool => ({ ...tool, action: mappings[tool.name] })), null, 2))
console.log(`Extracted ${definitions.length} existing tool descriptors for feature migration`)
