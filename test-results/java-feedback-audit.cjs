const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const assert = require('node:assert/strict');
function extract(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
  assert.equal(nodes.length, names.length);
  return nodes.map(n => n.getText(ast)).join('\n');
}
function run(source, context) {
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.React}}).outputText;
  vm.runInContext(js, context);
}
(async () => {
const ui = vm.createContext({React, useState: React.useState, useEffect:React.useEffect, Info:()=>null});
run(extract('src/renderer/src/App.tsx', ['JavaHomePreferenceRow']), ui);
const home = 'D:/Java/zulu-21';
const render = homes => renderToStaticMarkup(React.createElement(ui.JavaHomePreferenceRow,{label:'Java',description:'audit',value:home,homes,scanning:false,onChange:()=>{}}));
const listed = render([{home,major:21},{home:'C:/Java/jdk-17',major:17}]);
const custom = render([]);
assert.match(listed, /value="D:\/Java\/zulu-21" selected=""/);
assert.ok(listed.includes('<option value="D:/Java/zulu-21"'));
assert.match(listed, /<input[^>]*value="D:\/Java\/zulu-21"/);
assert.match(custom, /value="D:\/Java\/zulu-21" selected=""/);
assert.ok(custom.includes('<option value="D:/Java/zulu-21"'));
console.log('UI actual component: selected detected and custom paths both remain selected; input retains saved path.');
const root=await fsp.mkdtemp(path.join(os.tmpdir(),'modmind-java-audit-'));
const context=vm.createContext({fs:fsp,path,app:{getPath:()=>root},randomUUID:require('node:crypto').randomUUID,safeStorage:{isEncryptionAvailable:()=>false},normalizeAgentApprovalMode:()=> 'auto-review'});
run('let agentSettingsWriteTail = Promise.resolve();\n'+extract('src/main/index.ts',['settingsFile','normalizeJavaPreferences','normalizeNetworkProxyUrl','writeAgentSettingsAtomically','saveAgentSettings','readSettings']), context);
const prefs={game:'D:/Java/zulu-8',build:'D:/Java/zulu-21',tools:'D:/Java/zulu-17'};
let saved=await context.saveAgentSettings({javaPreferences:prefs,codingBackend:'codex'});
assert.equal(JSON.stringify(saved.javaPreferences),JSON.stringify(prefs));
const disk=JSON.parse(await fsp.readFile(path.join(root,'settings.json'),'utf8'));
assert.deepEqual(disk.javaPreferences,prefs);
const reread=await context.readSettings();
assert.equal(JSON.stringify(reread.javaPreferences),JSON.stringify(prefs));
console.log('Actual save/read functions with isolated userData: all three different Java preferences persisted to disk and reread unchanged. No Electron restart was exercised.');
await context.saveAgentSettings({...reread,javaPreferences:{...prefs,game:'D:/Java/zulu-21'}});
const changed=JSON.parse(await fsp.readFile(path.join(root,'settings.json'),'utf8'));
assert.equal(changed.javaPreferences.game,'D:/Java/zulu-21');
assert.ok(!JSON.stringify(changed).includes('D:/Java/zulu-8'));
console.log('Replacing the game preference saves the new path; the previous custom path has no retained history/library entry.');
console.log('Isolated evidence directory:',root);
})().catch(e=>{console.error(e);process.exitCode=1});
