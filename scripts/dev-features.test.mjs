import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {FeatureBuildQueue,publishBuild,selectedFeatures} from './dev-features.mjs'

test('serializes rebuilds, coalesces changes, and preserves edits made while a build is running',async()=>{
 const calls=[];let release;const blocked=new Promise(resolve=>{release=resolve})
 const queue=new FeatureBuildQueue(async id=>{calls.push(id);if(calls.length===1)await blocked},5)
 queue.enqueue(['one','one']);const run=queue.drain();queue.enqueue(['one','two']);release();await run
 assert.deepEqual(calls,['one','one','two']);queue.close()
})
test('continues rebuilding after a failed compilation',async()=>{
 const calls=[];const queue=new FeatureBuildQueue(async id=>{calls.push(id);if(calls.length===1)throw Error('expected fixture error')},5)
 queue.enqueue(['one']);await queue.drain();queue.enqueue(['one']);await queue.drain();assert.deepEqual(calls,['one','one']);queue.close()
})
test('publishes completed immutable packages and skips identical output',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'modmind-dev-publish-'))
 try{
  await fs.mkdir(path.join(base,'build','live-example'),{recursive:true});await fs.writeFile(path.join(base,'build/live-example.mmfeature'),'first')
  assert.equal(await publishBuild({id:'live-example'},base),true);const before=JSON.parse(await fs.readFile(path.join(base,'ready.json'),'utf8'))
  assert.equal(await publishBuild({id:'live-example'},base),false)
  await fs.writeFile(path.join(base,'build/live-example.mmfeature'),'second');assert.equal(await publishBuild({id:'live-example'},base),true)
  const after=JSON.parse(await fs.readFile(path.join(base,'ready.json'),'utf8'));assert.notEqual(before.builds[0].sha256,after.builds[0].sha256)
  assert.equal(await fs.readFile(path.join(base,before.builds[0].archive),'utf8'),'first')
 }finally{await fs.rm(base,{recursive:true,force:true})}
})
test('includes source dependencies and rejects unknown or builtin selections',async()=>{
 assert.equal((await selectedFeatures('image-studio')).at(-1).id,'image-studio')
 await assert.rejects(selectedFeatures('../outside'))
 await assert.rejects(selectedFeatures('studio-mod'))
})
