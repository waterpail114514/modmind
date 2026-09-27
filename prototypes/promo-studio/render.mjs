import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ffmpeg from 'ffmpeg-static';
import {serve} from './server.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const server=await serve(0);const port=server.address().port;
const browser=await chromium.launch({headless:true});
try{const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});page.on('pageerror',e=>{throw e});await page.goto(`http://127.0.0.1:${port}/?render`);await page.waitForFunction(()=>window.film?.ready);const duration=await page.evaluate(()=>window.film.duration());await fs.mkdir(path.join(root,'output'),{recursive:true});
if(process.argv.includes('--stills')){for(const t of [1,4,9,14,18,21.5,25,28.5,33,36.5,41,45,49,53,57,61,66,70]){await page.evaluate(t=>window.film.render(t),t);await page.screenshot({path:path.join(root,'output',`frame-${String(t).padStart(4,'0')}.png`)});}console.log('Stills rendered');}
else{const fps=30,frames=Math.round(duration*fps);const output=path.join(root,'output','modmind-promo-1080p.mp4');const enc=spawn(ffmpeg,['-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});let err='';enc.stderr.on('data',b=>err+=b.toString());const done=once(enc,'close');for(let i=0;i<frames;i++){const data=await page.evaluate(t=>{window.film.render(t);return document.querySelector('canvas').toDataURL('image/jpeg',.94).split(',')[1]},i/fps);if(!enc.stdin.write(Buffer.from(data,'base64')))await once(enc.stdin,'drain');if(i%150===0)console.log(`${Math.round(i/frames*100)}% (${i}/${frames})`)}enc.stdin.end();const [code]=await done;if(code!==0)throw Error(err);console.log(`Exported ${output} · ${duration}s · ${frames} frames`);}}
finally{await browser.close();server.close()}
