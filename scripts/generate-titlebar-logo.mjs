import { promises as fs } from 'node:fs'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true })
const builder = new XMLBuilder({ ignoreAttributes: false, preserveOrder: true, format: true, suppressEmptyNode: true })
const artwork = async file => parser.parse(await fs.readFile(file, 'utf8'))
  .find(node => node.svg).svg.filter(node => !node.title && !node.desc)

// Keep the approved horizontal lockup and its lowered wordmark in sync with the logo master.
const svg = builder.build([{
  svg: [
    { title: [{ '#text': 'ModMind' }] },
    { g: await artwork('logo.svg'), ':@': { '@_transform': 'translate(-72 -70) scale(0.65)' } },
    { g: await artwork('resources/wordmark.svg'), ':@': { '@_transform': 'translate(466 -11.5)' } }
  ],
  ':@': { '@_xmlns': 'http://www.w3.org/2000/svg', '@_width': '1630', '@_height': '490', '@_viewBox': '0 0 1630 490', '@_fill': 'none' }
}])
await fs.writeFile('src/renderer/src/assets/logo-wordmark.svg', svg)
// Only adjust the letter colors; preserve the character and gold accent.
await fs.writeFile('src/renderer/src/assets/logo-wordmark-dark.svg', svg
  .replace('id="wordmark-mod" fill="#2e3843"', 'id="wordmark-mod" fill="#dce4e8"')
  .replace('id="wordmark-mind" fill="#1e5a60"', 'id="wordmark-mind" fill="#74a5a8"'))
console.log('Generated light and dark titlebar logo lockups')
