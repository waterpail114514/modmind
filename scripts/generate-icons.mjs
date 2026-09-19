import { promises as fs } from 'node:fs'
import sharp from 'sharp'
import './generate-titlebar-logo.mjs'
const source = 'logo.png'
await sharp('logo.svg', { density: 144 }).resize(1024, 1024).png().toFile(source)
const square = size => sharp(source).trim().resize(size, size, {fit:'contain',kernel:'lanczos3',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer()
await fs.copyFile(source,'resources/logo.png')
for(const [target,size] of [['resources/icon.png',512],['src/renderer/src/assets/logo.png',512],['resources/renderer-public/favicon.png',64],['src/renderer/public/favicon.png',64]]) await fs.writeFile(target,await square(size))
await sharp({ create: { width: 1626, height: 540, channels: 4, background: '#ffffff' } })
  .composite([
    { input: await square(450), left: 20, top: 45 },
    { input: 'resources/wordmark.png', left: 480, top: 0 }
  ])
  .png()
  .toFile('resources/readme-logo.png')
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
console.log('Exported logo.svg to PNG and generated desktop, renderer, README, favicon and Windows ICO resources')
