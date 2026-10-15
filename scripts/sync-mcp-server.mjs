import { promises as fs } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'src/main/externalAgents.ts')
const sourceText = await fs.readFile(sourcePath, 'utf8')
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true)
let declaration
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) continue
  declaration = statement.declarationList.declarations.find(item => item.name.getText(source) === 'MCP_SERVER_SOURCE') ?? declaration
}
if (!declaration?.initializer) throw new Error('Embedded MCP source was not found')
const entry = `import { SERVER_SCENARIO_SCHEMA } from '../shared/serverScenario';
import { imageGenerationInputSchema, perfectPixelInputSchema } from '../shared/imageStudioRequest';
export default ${declaration.initializer.getText(source)};`
const compiled = await build({ stdin: { contents: entry, resolveDir: path.dirname(sourcePath), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const embedded = (await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)).default
const configLine = "const config = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'bridge.json'), 'utf8'));"
if (!embedded.includes(configLine)) throw new Error('Embedded MCP configuration loader changed; review the standalone adapter')
const adapter = `const configPath = process.env.MODMIND_BRIDGE_CONFIG
  ? path.resolve(process.env.MODMIND_BRIDGE_CONFIG)
  : path.join(path.dirname(path.resolve(process.argv[1])), 'bridge.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('bridge.json must contain a valid TCP port');
if (typeof config.token !== 'string' || config.token.length < 16) throw new Error('bridge.json must contain a non-empty bridge token');
const legacyPluginDiscovery = config.hasPluginTools === undefined;
if (legacyPluginDiscovery) config.hasPluginTools = true;`
const pluginDeclaration = 'async function fetchPluginTools() {'
if (!embedded.includes(pluginDeclaration)) throw new Error('Embedded MCP plugin discovery changed; review the standalone adapter')
const pluginAdapter = `
async function fetchPluginTools() {
  try { return await fetchPluginToolsStrict(); }
  catch (error) { if (legacyPluginDiscovery) return []; throw error; }
}
`
const generated = '#!/usr/bin/env node\n// Generated from ModMind externalAgents.ts; run scripts/sync-mcp-server.mjs --write in ModMind.\n' + embedded.replace(configLine, adapter).replace(pluginDeclaration, 'async function fetchPluginToolsStrict() {') + pluginAdapter
const target = path.join(root, 'modmind-mcp-open-source/src/mcp-server.mjs')
if (process.argv.includes('--write')) {
  await fs.writeFile(target, generated, 'utf8')
  console.log(`Updated ${pathToFileURL(target).pathname}`)
} else if ((await fs.readFile(target, 'utf8')).replaceAll('\r\n', '\n') !== generated.replaceAll('\r\n', '\n')) {
  throw new Error('Standalone MCP differs from the embedded transport. Run npm run sync:mcp, review the change, and test both transports.')
} else console.log('Standalone MCP matches the embedded transport')
