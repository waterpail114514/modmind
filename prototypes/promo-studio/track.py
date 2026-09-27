import cv2,numpy as np,json
from pathlib import Path
b=Path('prototypes/promo-studio');cap=cv2.VideoCapture(str(b/'reference.mp4'));frames=[]
while True:
 ok,f=cap.read()
 if not ok:break
 frames.append(f)
sift=cv2.SIFT_create(nfeatures=5000,contrastThreshold=.015);matcher=cv2.BFMatcher();tracks={}
# Corners describe the visible UI plane in the reference frame, in 640 x 360 coordinates.
for name,lo,hi,anchor,corners in [('welcome',510,620,600,[[83,34],[557,34],[557,330],[83,330]]),('response',734,808,780,[[56,67],[680,-25],[680,390],[10,360]]),('dark',1530,1648,1620,[[72,34],[548,34],[548,333],[72,333]]),('cards',1690,1905,1775,[[100,-120],[670,-60],[640,430],[-10,365]])]:
 gray=cv2.cvtColor(frames[anchor],cv2.COLOR_BGR2GRAY);mask=np.zeros_like(gray);cv2.fillConvexPoly(mask,np.int32(corners),255);ka,da=sift.detectAndCompute(gray,mask);rows=[]
 for i in range(lo,hi):
  kb,db=sift.detectAndCompute(cv2.cvtColor(frames[i],cv2.COLOR_BGR2GRAY),None)
  if db is None:continue
  pairs=matcher.knnMatch(da,db,k=2);good=[m for m,n in pairs if m.distance<.72*n.distance]
  if len(good)<9:continue
  h,ins=cv2.findHomography(np.float32([ka[m.queryIdx].pt for m in good]),np.float32([kb[m.trainIdx].pt for m in good]),cv2.RANSAC,3)
  if h is None or ins.sum()<8:continue
  q=cv2.perspectiveTransform(np.float32(corners).reshape(1,4,2),h)[0]
  if np.max(np.abs(q))>6000:continue
  rows.append({'frame':i,'corners':np.round(q*3,3).tolist(),'inliers':int(ins.sum())})
 tracks[name]={'anchor':anchor,'range':[lo,hi],'samples':rows};print(name,len(rows),'/',hi-lo)
(b/'analysis'/'camera-tracks.json').write_text(json.dumps(tracks));
