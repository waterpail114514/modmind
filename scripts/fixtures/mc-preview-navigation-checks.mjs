import assert from 'node:assert/strict'
import path from 'node:path'

const state = page => page.evaluate(()=>{const vp=window.__APP__.vp;return {target:[...vp.cam.target],xr:vp.cam.xr,yr:vp.cam.yr,dist:vp.cam.dist,blocks:window.__APP__.source.getBlocks().length}})
// The QA window is hidden. Flush the real renderer rather than waiting for
// background-throttled animation frames when measuring projected pointer motion.
const settled = page => page.evaluate(()=>window.__APP__.vp.draw())
const near = (actual,expected,message,tolerance=.65) => assert.ok(Math.abs(actual-expected)<tolerance,`${message}: ${actual} vs ${expected}`)

export async function checkEmptyNavigation(page,work,report) {
  await page.locator('#m_pan').click()
  const rect=await page.locator('#stage').boundingBox(),x=rect.x+rect.width*.5,y=rect.y+rect.height*.5
  const cases=[{yaw:0,pitch:0,zoom:1},{yaw:.6,pitch:.9,zoom:1},{yaw:1.8,pitch:1.5,zoom:2},{yaw:-2.2,pitch:-1.4,zoom:.5}]
  report.navigation=[]
  if(!process.argv.includes('--navigation-interruption-only')){
  for(const setting of cases) {
    await page.locator('#fitBtn').click()
    await page.evaluate(({yaw,pitch,zoom})=>{const vp=window.__APP__.vp;vp.setAngles(yaw,pitch,{animate:false});vp.zoomBy(zoom)},setting)
    await settled(page)
    const before=await state(page),point=before.target
    const start=await page.evaluate(point=>window.__APP__.vp.project(point),point)
    await page.mouse.move(x,y);await page.mouse.down({button:'right'})
    assert.deepEqual((await state(page)).target,before.target,'pressing right does not jump')
    await page.mouse.move(x+80,y+40,{steps:8});await settled(page)
    const end=await page.evaluate(point=>window.__APP__.vp.project(point),point)
    near(end[0]-start[0],80,'horizontal pan tracks screen pixels')
    near(end[1]-start[1],40,'vertical pan tracks screen pixels')
    const during=await state(page)
    near(during.xr,before.xr,'pan does not orbit',1e-6);near(during.yr,before.yr,'pan does not orbit',1e-6)
    await page.mouse.up({button:'right'})
    const released=await state(page)
    await page.mouse.move(x+100,y+70);await settled(page)
    assert.deepEqual((await state(page)).target,released.target,'release stops navigation immediately')
    await page.mouse.move(x+80,y+40);await page.mouse.down({button:'right'});await page.mouse.move(x,y,{steps:8});await page.mouse.up({button:'right'})
    const restored=await page.evaluate(point=>window.__APP__.vp.project(point),point)
    near(restored[0],start[0],'reverse drag returns horizontally');near(restored[1],start[1],'reverse drag returns vertically')
    report.navigation.push({...setting,screenDelta:[end[0]-start[0],end[1]-start[1]]})
  }
  await page.locator('#fitBtn').click();await settled(page)
  await page.mouse.move(x,y);await page.mouse.down({button:'right'})
  await page.mouse.move(rect.x-30,y+20,{steps:8})
  const outside=await state(page)
  await page.mouse.up({button:'right'});await page.mouse.move(x,y);await settled(page)
  assert.deepEqual((await state(page)).target,outside.target,'outside release does not leave a stuck drag')
  await page.evaluate(()=>{window.qaNavigationEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','mouseup','blur'])window.addEventListener(type,event=>window.qaNavigationEvents.push({type,button:event.button,buttons:event.buttons,pointerId:event.pointerId,target:event.composedPath()[0]?.id}),{capture:true});})
  await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.mouse.move(x+20,y+10)
  const wheelDuringPan=await state(page);await page.mouse.wheel(0,-120)
  assert.equal((await state(page)).dist,wheelDuringPan.dist,'wheel does not change depth during pan')
  await page.mouse.down({button:'left'});await page.mouse.up({button:'left'})
  const chord=await state(page)
  await page.mouse.move(x+60,y+30)
  report.chordEvents=await page.evaluate(()=>window.qaNavigationEvents)
  assert.notDeepEqual((await state(page)).target,chord.target,'unrelated button release does not terminate right pan')
  await page.mouse.down({button:'left'});await page.mouse.up({button:'right'})
  const rightReleased=await state(page)
  await page.mouse.move(x+90,y+50);assert.deepEqual((await state(page)).target,rightReleased.target,'right release stops pan while left remains held')
  await page.mouse.up({button:'left'})
  assert.equal((await state(page)).blocks,0,'camera navigation never places blocks')
  for(const reason of ['pointercancel','lostpointercapture','blur','Escape']) {
    await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.mouse.move(x+20,y+10)
    if(reason==='Escape')await page.keyboard.press('Escape');
    else await page.evaluate(reason=>{const canvas=document.querySelector('.mcp-host').shadowRoot.querySelector('#stage');if(reason==='blur')window.dispatchEvent(new Event('blur'));else canvas.dispatchEvent(new PointerEvent(reason,{pointerId:1,bubbles:true}));},reason)
    const cancelled=await state(page)
    await page.mouse.move(x+60,y+30);assert.deepEqual((await state(page)).target,cancelled.target,`${reason} releases drag`)
    await page.mouse.up({button:'right'})
  }
  await page.mouse.move(x,y);await page.mouse.down({button:'middle'});await page.mouse.move(x+35,y+20,{steps:4});await page.mouse.up({button:'middle'})
  const rotated=await state(page);await page.mouse.move(x+70,y+40);assert.deepEqual(await state(page),rotated,'middle orbit also stops on release')
  }
  await page.mouse.move(x,y)
  // Stretch only this test transition so a slow hidden-window input queue cannot
  // let it finish before the press. Capture the actual presentation at pointerdown.
  await page.evaluate(()=>{window.addEventListener('pointerdown',()=>{const vp=window.__APP__.vp;window.qaInterruptPress={xr:vp.cam.xr,yr:vp.cam.yr,active:vp.angleTween().active};},{capture:true,once:true});window.__APP__.vp.setAngles(2.4,.25,{duration:10000});})
  await page.waitForTimeout(60);await page.mouse.down({button:'right'})
  const presentation=await page.evaluate(()=>window.qaInterruptPress),grabbed=await state(page)
  assert.equal(presentation.active,true,'press arrives while the transition is active')
  near(grabbed.xr,presentation.xr,'pitch starts at presentation value',1e-6);near(grabbed.yr,presentation.yr,'yaw starts at presentation value',1e-6)
  await page.mouse.move(x+30,y)
  assert.equal(await page.evaluate(()=>window.__APP__.vp.angleTween().active),false,'drag interrupts view-cube animation')
  const interrupted=await state(page);await page.mouse.up({button:'right'});await page.waitForTimeout(100)
  assert.deepEqual(await state(page),interrupted,'interrupted animation does not pull the camera back')
  await page.screenshot({path:path.join(work,'navigation-checked.png')})
  await page.locator('#fitBtn').click();await page.locator('#m_place').click()
  report.checks.push(process.argv.includes('--navigation-interruption-only')?'动画运行中按下右键，从当前画面接续并立即取消动画，松键不回拉':'右键平移四种视角与缩放按像素跟随、反向回位、移出画布与组合按键、取消/失焦收尾、中键旋转和视角动画打断')
}

export async function checkSurfaceNavigation(page,report,work) {
  const rect=await page.locator('#stage').boundingBox()
  await settled(page)
  const {x,y}=await page.evaluate(rect=>{for(const cy of [.5,.6,.4])for(const cx of [.5,.6,.4]){const x=rect.x+rect.width*cx,y=rect.y+rect.height*cy;if(window.__APP__.vp.pick(x,y))return {x,y};}return {};},rect)
  assert.ok(Number.isFinite(x) && Number.isFinite(y),'pan starts on an actual building surface')
  const revision=await page.evaluate(()=>document.querySelector('.mcp-host').dataset.revision)
  const anchor=await page.evaluate(({x,y})=>window.__APP__.vp.beginPan(x,y),{x,y})
  assert.ok(anchor?.point)
  const before=await page.evaluate(point=>window.__APP__.vp.project(point),anchor.point)
  await page.screenshot({path:path.join(work,'pan-surface-before.png')})
  await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.mouse.move(x+65,y-30,{steps:8});await settled(page)
  await page.screenshot({path:path.join(work,'pan-surface-during.png')})
  await page.mouse.up({button:'right'});await settled(page)
  const after=await page.evaluate(point=>window.__APP__.vp.project(point),anchor.point)
  near(after[0]-before[0],65,'surface follows cursor horizontally');near(after[1]-before[1],-30,'surface follows cursor vertically')
  report.surfaceNavigation={start:before,end:after,screenDelta:[after[0]-before[0],after[1]-before[1]]}
  assert.equal(await page.evaluate(()=>document.querySelector('.mcp-host').dataset.revision),revision,'right pan does not edit or save the building')
  await page.locator('#fitBtn').click()
  report.checks.push('建筑表面抓取点在 1080 窗口中随鼠标移动，不随透视深度加速')
}
