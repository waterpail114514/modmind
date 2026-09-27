from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json,random,subprocess
root=Path(__file__).resolve().parent
lines=root.joinpath('pain-points.txt').read_text(encoding='utf-8-sig').strip().splitlines()
assert len(lines)==90,len(lines)
for p in ['layers','stages']:root.joinpath(p).mkdir(exist_ok=True)
fontpath='C:/Windows/Fonts/msyh.ttc'
W,H=1920,1080
# Fill 90 distinct cells without overlap. Each batch spans the whole image.
cells=[(r,c) for r in range(18) for c in range(5)]
rng=random.Random(20260913);rng.shuffle(cells)
# Alternate pack and development issues, preserving each unique statement.
ordered=[lines[k//2+(45 if k%2 else 0)] for k in range(90)]
canvas=Image.new('RGB',(W,H),'black');manifest=[]
for batch in range(15):
 layer=Image.new('RGBA',(W,H),(0,0,0,0));draw=ImageDraw.Draw(layer)
 shade=round(92+(255-92)*batch/14)
 for j in range(6):
  idx=batch*6+j;row,col=cells[idx];full=ordered[idx];category,phrase=full.split('：',1)
  x=30+col*378;y=27+row*57
  size=25;font=ImageFont.truetype(fontpath,size)
  while draw.textbbox((0,0),phrase,font=font)[2]>354:
   size-=1;font=ImageFont.truetype(fontpath,size)
  bbox=draw.textbbox((0,0),phrase,font=font)
  draw.text((x,y+(34-(bbox[3]-bbox[1]))/2-bbox[1]),phrase,font=font,fill=(shade,shade,shade,255))
  manifest.append(dict(id=idx+1,category=category,text=phrase,batch=batch+1,startFrame=batch*4,startSeconds=batch/15,x=x,y=y,fontSize=size,color=f'#{shade:02x}{shade:02x}{shade:02x}'))
 layer.save(root/'layers'/f'batch-{batch+1:02}.png')
 canvas=Image.alpha_composite(canvas.convert('RGBA'),layer).convert('RGB')
 canvas.save(root/'stages'/f'stage-{batch+1:02}.png')
canvas.save(root/'final-frame.png')
(root/'timing.json').write_text(json.dumps(dict(width=W,height=H,fps=60,duration=1,batches=15,framesPerBatch=4,items=manifest),ensure_ascii=False,indent=2),encoding='utf-8')
ffmpeg=subprocess.check_output(['node','-p',"require('ffmpeg-static')"],text=True,encoding='utf-8').strip()
args=[ffmpeg,'-y','-f','image2pipe','-vcodec','png','-framerate','15','-i','pipe:0','-an','-r','60','-c:v','libx264','-crf','15','-pix_fmt','yuv420p','-movflags','+faststart',str(root/'pain-points-1s.mp4')]
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
for i in range(15):p.stdin.write((root/'stages'/f'stage-{i+1:02}.png').read_bytes())
p.stdin.close();err=p.stderr.read();assert p.wait()==0,err.decode(errors='replace')
# Separate viewing copy adds a 2-second hold, without changing the editing asset.
subprocess.run([ffmpeg,'-y','-i',str(root/'pain-points-1s.mp4'),'-vf','tpad=stop_mode=clone:stop_duration=2','-an','-c:v','libx264','-crf','15','-pix_fmt','yuv420p',str(root/'preview-with-hold.mp4')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
print('90 unique pain points; 15 batches; 60 frames; 1920x1080; no audio; assets ready.')

