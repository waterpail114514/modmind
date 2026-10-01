import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const file = path.resolve(import.meta.dirname, '../src/main/index.ts')
const source = await readFile(file, 'utf8')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const properties = new Set([
  'resourcePackOperation', 'soundRead', 'soundCreate', 'mappingsSearch', 'mappingsClass',
  'dependencySearch', 'dependencyInstall', 'mavenDependencyInstall', 'addonRelationships', 'addonPrepare', 'addonImport', 'addonLinkProject',
  'contentValidate', 'releasePreflight', 'modpackPlan', 'modpackApplyPlan', 'modpackMigrationTargets', 'modpackMigrationPreview',
  'modpackMigrationApply', 'modpackMigrationHistory', 'modpackMigrationUndo', 'modpackDownloadContent', 'mcmodSearch', 'mcmodFiles',
  'modpackWriteFtbQuest', 'modpackWritePatchouliBook', 'modpackApplyKeybindPreset', 'modpackApplyOptimizationProfile',
  'blockbenchActions', 'blockbenchProjectState', 'blockbenchValidate', 'blockbenchCaptureViews', 'blockbenchHistory',
  'blockbenchCheckpoint', 'blockbenchRestoreHistory', 'assetCompileIntent', 'assetPreviewIntent', 'assetApplyIntent',
  'assetCompileRefinement', 'assetPreviewRefinement', 'assetApplyRefinement', 'assetCompileAdvanced', 'assetPreviewAdvanced',
  'assetApplyAdvanced', 'assetCompileReference', 'assetPreviewReference', 'assetApplyReference', 'assetVisualReview',
  'imageGenerate', 'imageStudioAvailable', 'imageStudioInfo', 'imageProcess'
])
const edits = []
function visit(node) {
  if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isSpreadAssignment(property) && ts.isCallExpression(property.expression) && property.expression.expression.getText(ast) === 'featureAgentHandlers')) {
    for (const property of node.properties) {
      if (!property.name || !properties.has(property.name.getText(ast))) continue
      let end = property.end
      while (source[end] === ' ' || source[end] === '\r' || source[end] === '\n') end++
      if (source[end] === ',') end++
      edits.push({ start: property.getFullStart(), end })
    }
    return
  }
  ts.forEachChild(node, visit)
}
visit(ast)
let result = source
for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + result.slice(edit.end)
await writeFile(file, result)
console.log(`Removed ${edits.length} dedicated feature bridge properties`)
