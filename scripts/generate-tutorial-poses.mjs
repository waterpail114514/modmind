import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'

// Original hand-drawn gesture paths, sharing the approved mascot's head and clothing.
const out = 'output/tutorial-mascot'
await fs.mkdir(out, { recursive: true })
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false })
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, format: true, suppressEmptyNode: true })
const tree = parser.parse(await fs.readFile('logo.svg', 'utf8')).find(n => n.svg).svg
const group = id => tree.find(n => n[':@']?.['@_id'] === id)
const character = group('character-and-props').g
const part = id => character.find(n => n[':@']?.['@_id'] === id)
const serialize = nodes => builder.build(nodes)
const defs = serialize(tree.filter(n => n.defs))
const head = serialize([part('cat-ears'), part('face'), part('fringe-and-side-locks')])
const hoodieParts = part('hoodie').g.filter(n => n.path)
const body = serialize([part('back-hair')]) + `<g id="tutorial-hoodie">
${serialize(hoodieParts.slice(0, 3))}
<path d="M468 607L499 626L533 606C567 602 599 609 614 637C631 668 639 715 638 749C638 766 626 777 610 777H418C400 777 393 767 394 750L400 661C403 631 427 614 468 607Z" fill="url(#sweater)"/>
<path d="M413 631C394 640 384 673 381 706L379 747C378 763 387 773 402 773H430L436 748L416 744L424 677Z" fill="url(#sweater)"/>
<path d="M417 680L410 738Q409 747 416 749L442 753" stroke="#086970" stroke-width="4" stroke-linecap="round" fill="none"/>
<path d="M453 725L441 757Q440 762 446 762H574Q580 762 579 757L568 725" stroke="#096b71" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
${serialize(hoodieParts.slice(4).filter((_, i) => i !== 2))}
</g>`
const hand = d => `<path d="${d}" fill="url(#skin)"/>`
const line = d => `<path d="${d}" fill="none" stroke="#d1a58f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
const smile = '<path d="M477 574Q484 580 491 574" fill="none" stroke="#a16f60" stroke-width="2.5" stroke-linecap="round"/>'
const sleeve = `<g id="raised-sleeve">
  <path d="M593 628C611 620 625 635 631 654L643 689C650 676 657 654 663 637L693 647C687 678 677 709 661 726C650 738 632 737 621 725C610 712 605 690 599 672Z" fill="url(#sweater)"/>
  <path d="M631 671C636 685 638 697 646 705" fill="none" stroke="#07636a" stroke-width="4" stroke-linecap="round"/>
  <path d="M662 637Q661 632 666 631L690 638Q696 640 695 645L692 655L659 645Z" fill="#263640"/>
</g>`
const poses = [
  { name: '01-guide', label: '指引', usage: '放在教程左侧，指向右侧的按钮或步骤。',
    gesture: sleeve + hand('M669 641L670 622C669 617 672 611 678 609L706 592C712 588 717 594 712 599L696 612L710 611C717 611 719 616 716 620C720 626 716 631 711 632C712 638 705 642 699 642L688 646Z') + line('M690 622L708 620M690 629L708 627'), mouth: smile },
  { name: '02-done', label: '确认', usage: '操作成功、保存完成或步骤通过。',
    gesture: sleeve + hand('M669 641L666 620Q665 613 673 610L680 607L682 590C683 582 693 582 694 590L694 608L705 609Q713 610 713 618L710 637Q709 645 701 646L687 646Z') + line('M696 617L707 618M695 625L706 626M694 633L704 634'), mouth: smile },
  { name: '03-think', label: '思考', usage: '解释原因、对比选项或排查问题。',
    gesture: `<g id="thinking-arm"><path d="M598 637C615 635 629 650 634 671L641 705C642 722 627 731 614 721L542 636L564 614L611 666L601 648Z" fill="url(#sweater)"/><path d="M545 639L614 720Q625 732 636 719M574 626L610 666" stroke="#08636b" stroke-width="3.5" stroke-linecap="round" fill="none"/><path d="M541 635L531 621Q529 616 533 612L550 599Q554 596 558 601L569 615Z" fill="#263640"/>${hand('M534 615L525 603C521 599 524 594 529 594L523 583C519 576 527 571 532 577L543 592L549 589C555 585 561 590 562 596L563 607L545 622Z')}${line('M536 599L542 606')}</g>`, mouth: '<path d="M476 576L486 576" stroke="#a16f60" stroke-width="2.5" stroke-linecap="round"/>' },
  { name: '04-tip', label: '提醒', usage: '强调一个注意点、前置条件或易错项。',
    gesture: sleeve + hand('M669 641L665 624C664 618 668 614 674 614L674 586C674 578 685 578 685 586L686 611L694 610C700 609 703 613 704 617C711 616 716 621 714 628L710 640Q708 646 700 646H686Z') + line('M685 620L685 630M695 620L695 632M704 623L703 634'), mouth: '<path d="M479 574Q484 572 489 574" stroke="#a16f60" stroke-width="2.5" stroke-linecap="round"/>' },
  { name: '05-welcome', label: '欢迎', usage: '教程开场、章节开头或结束致意。',
    gesture: sleeve + hand('M669 641L658 619C655 613 649 607 653 603C657 599 662 605 667 608L662 586C661 580 669 578 671 585L677 603L676 579C676 572 685 572 685 579L686 602L690 583C692 577 700 580 698 587L695 609L701 598C705 592 712 597 708 603L701 622L695 637L687 646Z') + line('M678 616Q686 611 693 616'), mouth: smile },
  { name: '06-explain', label: '讲解', usage: '引出概念、展示结果或提供下一步建议。',
    gesture: sleeve + hand('M669 641L670 631C662 629 656 625 653 620C649 614 657 610 661 614L673 620L684 619L674 611C669 607 674 601 679 604L693 613L710 609C717 607 720 614 714 618L704 624L716 621C723 619 726 625 719 630L707 638C703 643 696 646 687 646Z') + line('M678 628Q688 633 699 629'), mouth: smile }
]

for (const pose of poses) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="260 210 560 600" fill="none" role="img" aria-labelledby="pose-title pose-desc">
<title id="pose-title">ModMind · ${pose.label}</title><desc id="pose-desc">${pose.usage} 小幅度静态动作，透明背景。</desc>
${defs}
<g id="mascot">
${body}${head}<g id="expression">${pose.mouth}</g>
<g id="gesture">${pose.gesture}</g>
</g>
</svg>`
  if (XMLValidator.validate(svg) !== true) throw new Error(`Invalid SVG: ${pose.name}`)
  await fs.writeFile(path.join(out, `${pose.name}.svg`), svg)
  await sharp(Buffer.from(svg), { density: 144 }).resize(960, 960).png().toFile(path.join(out, `${pose.name}.png`))
}
await fs.writeFile(path.join(out, 'README.md'), `# ModMind 教程动作素材\n\n六张小幅度静态动作，SVG 为独立矢量文件，不依赖字体或外链图片。PNG 为 960×960 透明背景。画布和人物位置一致。\n\n${poses.map(p=>`- ${p.name}：${p.label}。${p.usage}`).join('\n')}\n\n在教程截图旁按需使用，不是循环动画。\n`)
const cards = poses.map(p => `<article><img src="${p.name}.svg" alt="${p.label}"/><h2>${p.label}</h2><p>${p.usage}</p><a href="${p.name}.svg" download>SVG</a> · <a href="${p.name}.png" download>PNG</a></article>`).join('')
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ModMind 教程动作</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f5f5;color:#2e3843;font:15px "Microsoft YaHei",sans-serif;padding:36px}header{display:flex;align-items:center;justify-content:space-between}h1{font-size:24px;margin:0 0 12px}button{border:1px solid #aab5b8;background:transparent;color:inherit;border-radius:6px;padding:8px 14px;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:24px}article{padding:16px;background:#fff;border-radius:12px}img{display:block;width:100%;aspect-ratio:1;object-fit:contain}h2{font-size:17px;margin:8px 0}p{font-size:13px;line-height:1.7;margin:8px 0;color:#626970}a{color:#157b80;font-size:13px}body.dark{background:#20272e;color:#e6ebee}.dark article{background:#36424e}.dark p{color:#bbc8cc}.dark a{color:#8dc8c8}@media(max-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:16px}}</style><header><div><h1>ModMind 教程动作</h1><span>小幅度 · 透明背景 · 独立 SVG</span></div><button onclick="document.body.classList.toggle('dark')">切换深浅背景</button></header><main class="grid">${cards}</main></html>`)
console.log(`Exported ${poses.length} SVG poses, PNGs and preview gallery to ${out}`)
