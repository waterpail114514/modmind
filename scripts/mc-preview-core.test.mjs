import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {validateBuild,queryDocuments,changeDocument} from '../vendor/mc-offline-tool/src/structure-store.mjs'
import {parseNbt,readNbtFile} from '../vendor/mc-offline-tool/src/nbt.mjs'
import {readBuildFile} from '../vendor/mc-offline-tool/src/schem-reader.mjs'
import {writeSchem,writeLitematic} from '../vendor/mc-offline-tool/preview/api.mjs'
import {structureToBuildJson} from '../vendor/mc-offline-tool/preview/src/io.js'
const require=createRequire(import.meta.url),D=require('../vendor/mc-offline-tool/preview/vendor/deepslate.umd.cjs')
const building={name:'Directions',dataVersion:3955,size:[2,1,1],palette:[{Name:'minecraft:oak_stairs',Properties:{facing:'north',half:'bottom',shape:'straight',waterlogged:'false'}},{Name:'minecraft:oak_stairs',Properties:{facing:'south',half:'top',shape:'straight',waterlogged:'false'}}],blocks:[{pos:[0,0,0],state:0},{pos:[1,0,0],state:1}]}
test('actual Deepslate structure preserves different properties of the same block',()=>{
  const structure=new D.Structure(building.size)
  for(const block of building.blocks){const entry=building.palette[block.state];structure.addBlock(block.pos,entry.Name,entry.Properties)}
  const result=structureToBuildJson(structure)
  assert.notEqual(result.blocks[0].state,result.blocks[1].state)
  assert.equal(result.palette[result.blocks[1].state].Properties.facing,'south')
})
test('export keeps source DataVersion and direction properties in both formats',()=>{
  for(const [format,writer] of [['schem',writeSchem],['litematic',writeLitematic]]){
    const bytes=writer(building),root=readNbtFile(bytes).value
    assert.equal(root.DataVersion || root.MinecraftDataVersion,3955)
    const result=readBuildFile(bytes,'directions.'+format)
    assert.equal(result.palette[result.blocks[1].p].props.facing,'south')
  }
})

test('Litematic signed region sizes retain relative placement and invalid references stay invalid',()=>{
  const file=D.NbtFile.read(writeLitematic(building)),regions=file.root.getCompound('Regions'),key=[...regions.keys()][0],first=regions.getCompound(key);
  first.getCompound('Position').set('x',new D.NbtInt(3));
  first.getCompound('Size').set('x',new D.NbtInt(-2));
  const second=D.NbtCompound.fromJson(first.toJson());
  second.getCompound('Position').set('x',new D.NbtInt(0));
  second.getCompound('Size').set('x',new D.NbtInt(2));
  regions.set('second',second);
  const result=readBuildFile(Buffer.from(file.write()),'signed.litematic');
  assert.equal(result.size.x,4);
  assert.deepEqual(result.blocks.map(block=>block.x),[2,3,0,1]);
  const single=D.NbtFile.read(writeLitematic(building)),region=single.root.getCompound('Regions').getCompound(key);
  region.set('BlockStates',new D.NbtLongArray([3n]));
  const corrupt=readBuildFile(Buffer.from(single.write()),'corrupt.litematic');
  assert.equal(corrupt.stats.skippedBadRef,1);
})
test('truncated NBT compounds and oversized list claims fail with bounded reads',()=>{
  assert.throws(()=>parseNbt(Buffer.from([10,0,0,10,0,0])),/不完整/)
  assert.throws(()=>parseNbt(Buffer.from([10,0,0,9,0,1,97,10,127,255,255,255])),/长度/)
})
test('invalid coordinates, duplicate blocks and oversized bounds are rejected',()=>{
  assert.throws(()=>validateBuild({...building,size:[2048,2048,2048]}),/尺寸/)
  assert.throws(()=>validateBuild({...building,blocks:[{pos:[2,0,0],state:0}]}),/坐标/)
  assert.throws(()=>validateBuild({...building,blocks:[building.blocks[0],building.blocks[0]]}),/重复/)
  assert.throws(()=>validateBuild({...building,blocks:[{pos:[0,0,0],state:20}]}),/调色板/)
})
test('project documents persist, reject stale edits, preserve backups and isolate projects',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'modmind-structures-')),other=path.join(root,'other');fs.mkdirSync(other)
  try {
    const first=changeDocument({projectPath:root,operation:'create',build:building}).document
    assert.equal(queryDocuments({projectPath:other}).items.length,0)
    assert.throws(()=>changeDocument({projectPath:root,operation:'save',id:first.id,expectedRevision:3,build:building}),/更新/)
    const second=changeDocument({projectPath:root,operation:'rename',id:first.id,expectedRevision:1,name:'Renamed'}).document
    assert.equal(second.revision,2)
    assert.equal(queryDocuments({projectPath:root,id:first.id}).document.build.name,'Renamed')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'structures',first.id+'.modmind.json.bak'),'utf8')).revision,1)
    changeDocument({projectPath:root,operation:'delete',id:first.id,expectedRevision:2})
    assert.equal(queryDocuments({projectPath:root}).items.length,0)
    assert.ok(fs.readdirSync(path.join(root,'structures')).some(name=>name.includes('.deleted-')))
    assert.throws(()=>queryDocuments({projectPath:root,id:'../escape'}),/ID/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
