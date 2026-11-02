import assert from 'node:assert/strict'
import path from 'node:path'

async function viewport(page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return {x:matrix.e,y:matrix.f,zoom:matrix.a}
  })
}

/** Real mouse input against the bundled canvas, including editable-content boundaries. */
export async function checkCanvasInteractions(page, output, name) {
  await page.getByTestId('open-canvas-import').setInputFiles({name:'navigation.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({title:'交互验收',graph:{version:1,viewport:{x:0,y:0,zoom:1},nodes:[],edges:[]}}))})
  await page.locator('.oc-canvas-title').filter({hasText:'交互验收'}).waitFor()
  await page.waitForFunction(()=>document.querySelectorAll('.react-flow__node').length===0)
  const bounds=await page.locator('.react-flow__pane').boundingBox()
  assert(bounds)
  const point={x:bounds.x+bounds.width*.45,y:bounds.y+bounds.height*.25}
  const before=await viewport(page)
  await page.mouse.dblclick(point.x,point.y)
  const menu=page.getByRole('menu',{name:'添加节点',exact:true})
  await menu.waitFor()
  assert.equal(await menu.count(),1,'double click must open one node menu')
  assert.deepEqual(await viewport(page),before,'double click must not zoom the canvas')
  await page.screenshot({path:path.join(output,name+'-add-node.png')})
  await menu.getByRole('menuitem',{name:/图片/}).click()
  await page.locator('.react-flow__node-image').waitFor()
  await page.getByLabel('图片提示词',{exact:true}).waitFor()
  assert.equal(await page.locator('.react-flow__node-image').count(),1)
  assert.equal(await page.evaluate(()=>window.canvasQa.requests.length),0,'creating a node must not submit generation')

  const wheelPoint={x:Math.floor(bounds.x+bounds.width*.9),y:Math.floor(bounds.y+bounds.height*.12)}
  const zoomBefore=await viewport(page)
  const world={x:(wheelPoint.x-bounds.x-zoomBefore.x)/zoomBefore.zoom,y:(wheelPoint.y-bounds.y-zoomBefore.y)/zoomBefore.zoom}
  await page.mouse.move(wheelPoint.x,wheelPoint.y)
  await page.mouse.wheel(0,-120)
  await page.waitForFunction(zoom=>new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a>zoom,zoomBefore.zoom)
  const enlarged=await viewport(page)
  assert(enlarged.zoom>zoomBefore.zoom,'wheel up must zoom in')
  assert(Math.abs((wheelPoint.x-bounds.x-enlarged.x)/enlarged.zoom-world.x)<.1,'zoom must keep the pointer world x fixed')
  assert(Math.abs((wheelPoint.y-bounds.y-enlarged.y)/enlarged.zoom-world.y)<.1,'zoom must keep the pointer world y fixed')
  await page.mouse.wheel(0,120)
  await page.waitForFunction(zoom=>new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a<zoom,enlarged.zoom)
  assert((await viewport(page)).zoom<enlarged.zoom,'wheel down must zoom out')

  // Pane double click must not steal double click or scrolling inside the prompt editor.
  const prompt=page.getByLabel('图片提示词',{exact:true})
  await prompt.fill(Array.from({length:30},(_,index)=>'提示词编辑 '+index).join('\n'))
  await prompt.dblclick()
  assert.equal(await menu.count(),0)
  assert.equal(await page.locator('.react-flow__node-image').count(),1)
  const editorBefore=await viewport(page),editorBounds=await prompt.boundingBox()
  assert(editorBounds)
  await page.mouse.move(editorBounds.x+20,editorBounds.y+20)
  await page.mouse.wheel(0,180)
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="图片提示词"]').scrollTop>0)
  assert.deepEqual(await viewport(page),editorBefore,'scrolling prompt text must not zoom or pan the canvas')
  await page.screenshot({path:path.join(output,name+'-zoom-editor.png')})

  await page.getByTestId('open-canvas-import').setInputFiles({name:'mouse-buttons.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({title:'鼠标按键验收',graph:{version:1,viewport:{x:0,y:0,zoom:1},nodes:[100,410].map((x,index)=>({id:'mouse-'+index,type:'image',position:{x,y:100},width:240,data:{title:'框选 '+index,prompt:'',model:'image-fixture',aspectRatio:'1:1',resolution:'1K'}})),edges:[]}}))})
  await page.locator('.oc-canvas-title').filter({hasText:'鼠标按键验收'}).waitFor()
  await page.waitForFunction(()=>document.querySelectorAll('.react-flow__node-image').length===2)
  const pane=await page.locator('.react-flow__pane').boundingBox()
  const panStart={x:Math.floor(pane.x+pane.width*.85),y:Math.floor(pane.y+pane.height*.7)}
  const panBefore=await viewport(page)
  await page.mouse.move(panStart.x,panStart.y)
  await page.mouse.down({button:'left'})
  await page.mouse.move(panStart.x+40,panStart.y+25,{steps:6})
  await page.mouse.up({button:'left'})
  const panned=await viewport(page)
  assert(Math.abs(panned.x-panBefore.x-40)<1&&Math.abs(panned.y-panBefore.y-25)<1,'left drag must pan the canvas')
  assert.equal(await page.locator('.react-flow__node.selected').count(),0,'left drag must not box select')

  const frameStart={x:pane.x+20,y:pane.y+40},frameEnd={x:pane.x+700,y:pane.y+190}
  await page.mouse.move(frameStart.x,frameStart.y)
  await page.mouse.down({button:'right'})
  await page.mouse.move(frameEnd.x,frameEnd.y,{steps:8})
  await page.waitForFunction(()=>document.querySelectorAll('.react-flow__node.selected').length===2)
  assert.deepEqual(await viewport(page),panned,'right drag must not pan')
  await page.screenshot({path:path.join(output,name+'-right-selection.png')})
  await page.mouse.up({button:'right'})
  assert.equal(await page.getByRole('menu').count(),0,'right drag must not open a menu')
  assert.equal(await page.locator('.canvas-studio > .react-flow__selection').count(),0,'selection rectangle must clear on release')
  await page.mouse.click(panStart.x,panStart.y,{button:'right'})
  await page.getByRole('menu',{name:'画布命令',exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.mouse.click(panStart.x,panStart.y)
  assert.equal(await page.locator('.react-flow__node.selected').count(),0,'left click must clear the selection')
  const node=page.locator('.react-flow__node-image').first(),nodeBefore=await node.boundingBox()
  const nodeViewport=await viewport(page)
  await page.mouse.move(nodeBefore.x+30,nodeBefore.y+30)
  await page.mouse.down({button:'left'})
  await page.mouse.move(nodeBefore.x+60,nodeBefore.y+50,{steps:6})
  await page.mouse.up({button:'left'})
  const nodeAfter=await node.boundingBox()
  assert(nodeAfter.x-nodeBefore.x>20&&nodeAfter.x-nodeBefore.x<=30&&nodeAfter.y-nodeBefore.y>10&&nodeAfter.y-nodeBefore.y<=20,'left drag must still move a node beyond its drag threshold')
  assert.deepEqual(await viewport(page),nodeViewport,'dragging a node must not pan the canvas')
  await page.mouse.move(frameStart.x,frameStart.y)
  await page.mouse.down({button:'right'})
  await page.mouse.move(frameStart.x+50,frameStart.y+50,{steps:4})
  const selection=page.locator('.canvas-studio > .react-flow__selection')
  assert.equal(await selection.count(),1)
  assert.notEqual(await selection.evaluate(element=>getComputedStyle(element).borderTopStyle),'none','selection rectangle must be visible')
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  assert.equal(await selection.count(),0,'losing focus must clear the selection rectangle')
  await page.mouse.up({button:'right'})
}
