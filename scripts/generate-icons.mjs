import { promises as fs } from 'node:fs'
import sharp from 'sharp'
const source = 'logo.png'
const square = size => sharp(source).resize(size, size, {fit:'contain',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer()
await fs.copyFile(source,'resources/logo.png')
for(const [target,size] of [['resources/icon.png',512],['src/renderer/src/assets/logo.png',512],['resources/renderer-public/favicon.png',64],['src/renderer/public/favicon.png',64]]) await fs.writeFile(target,await square(size))
const sizes=[16,24,32,48,64,128,256], images=await Promise.all(sizes.map(square))
const directory=Buffer.alloc(6+16*sizes.length)
directory.writeUInt16LE(1,2);directory.writeUInt16LE(sizes.length,4)
let offset=directory.length
for(let i=0;i<sizes.length;i++) {
  const e=6+i*16
  directory[e]=directory[e+1]=sizes[i]===256?0:sizes[i]
  directory.writeUInt16LE(1,e+4);directory.writeUInt16LE(32,e+6)
  directory.writeUInt32LE(images[i].length,e+8);directory.writeUInt32LE(offset,e+12)
  offset+=images[i].length
}
await fs.writeFile('resources/icon.ico',Buffer.concat([directory,...images]))
console.log('Generated desktop, renderer, favicon and Windows ICO resources')
