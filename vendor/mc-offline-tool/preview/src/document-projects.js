// Keep the standalone viewer's storage, but use project files inside ModMind.
import * as legacy from './projects.js';
import { isFeature, hostDocuments, hostSaveDocument } from './host.js';
let entries = [], revisions = new Map();
export async function initialize() {
  if (!isFeature()) return;
  entries = (await hostDocuments({})).items;
  revisions = new Map(entries.map(entry => [entry.id, entry.revision]));
}
export const list = () => isFeature() ? entries : legacy.list();
export const lastId = () => isFeature() ? entries.find(entry => !entry.error)?.id : legacy.lastId();
export const usage = () => isFeature() ? { chars: entries.reduce((sum,entry) => sum+entry.bytes,0), max: Infinity } : legacy.usage();
export const setLast = id => isFeature() ? {ok:true} : legacy.setLast(id);
export const migrateLegacy = () => isFeature() ? {migrated:false} : legacy.migrateLegacy();
async function change(input) {
  try {
    const result = await hostSaveDocument(input);
    entries = result.items;
    if(result.document) revisions.set(result.document.id,result.document.revision);
    return {ok:true,id:result.document?.id,blocks:result.document?.build.blocks.length,bytes:result.document ? JSON.stringify(result.document.build).length : 0,last:lastId()};
  } catch(error) { return {ok:false,why:String(error.message || error)}; }
}
export const create = (name,build) => isFeature() ? change({operation:'create',name,build}) : legacy.create(name,build);
export const save = (id,build) => isFeature() ? change({operation:'save',id,build,expectedRevision:revisions.get(id)}) : legacy.save(id,build);
export const rename = (id,name) => isFeature() ? change({operation:'rename',id,name,expectedRevision:revisions.get(id)}) : legacy.rename(id,name);
export const remove = id => isFeature() ? change({operation:'delete',id,expectedRevision:revisions.get(id)}) : legacy.remove(id);
export async function load(id) {
  if(!isFeature()) return legacy.load(id);
  try {
    const {document} = await hostDocuments({id});
    revisions.set(id,document.revision);
    return document.build;
  } catch { return null; }
}
