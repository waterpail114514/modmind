from pathlib import Path
import cv2, numpy as np, json
base=Path('prototypes/promo-studio'); out=base/'analysis';out.mkdir(exist_ok=True)
shots=[r'C:/Users/WATERP~1/AppData/Local/Temp/codex-clipboard-'+s+'.png' for s in ['17d5f284-4676-4781-b95a-d407d2caa4ad','38fc14fa-0c14-4ba8-9ee2-4b4aded63998','83ef2d25-ef4b-42c2-bff0-5d87646698c4','cc6cb7e7-f743-4dd4-bd4f-3ebe501852d1']]
def thumb(im):
 im=cv2.resize(im,(320,180));return im[35:155,30:295].astype(np.float32)
targets=[thumb(cv2.imdecode(np.fromfile(f,dtype=np.uint8),1)) for f in shots]
cap=cv2.VideoCapture(str(base/'reference.mp4'));fps=cap.get(cv2.CAP_PROP_FPS);n=int(cap.get(cv2.CAP_PROP_FRAME_COUNT));best=[(1e9,0,None) for _ in targets];bright=[]
for i in range(n):
 ok,im=cap.read()
 if not ok:break
 a=thumb(im);bright.append(float(a.mean()))
 for j,b in enumerate(targets):
  d=float(((a-b)**2).mean())
  if d<best[j][0]:best[j]=(d,i,im.copy())
cap.release(); report={'fps':fps,'frames':n,'duration':n/fps,'matches':[]}
for j,(err,i,im) in enumerate(best):
 cv2.imwrite(str(out/f'reference-anchor-{j+1}.png'),im);report['matches'].append({'anchor':j+1,'frame':i,'time':i/fps,'mse':err})
 # preserve supplied full resolution frames
 im=cv2.imdecode(np.fromfile(shots[j],dtype=np.uint8),1);cv2.imwrite(str(out/f'user-anchor-{j+1}.png'),im)
(out/'anchors.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
