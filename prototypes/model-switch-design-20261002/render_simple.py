"""Render the compact design as a static concept illustration."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json
OUT=Path(__file__).parent
S=2
def render(width=1100,dark=False):
    narrow=width<600
    p=dict(canvas='#f5f6f7',panel='#eceef0',surface='#f9fafb',raised='#ffffff',text='#2e3843',muted='#626970',line='#dce0e4',accent='#1e5a60',selected='#e1e6e8')
    if dark:p.update(canvas='#23272b',panel='#282d32',surface='#2e343a',raised='#363d44',text='#e8ecef',muted='#aeb7bf',line='#404950',accent='#84c4c4',selected='#384249')
    img=Image.new('RGB',(width*S,1100*S),p['canvas']);d=ImageDraw.Draw(img)
    def f(z,b=False):return ImageFont.truetype('C:/Windows/Fonts/'+('msyhbd.ttc' if b else 'msyh.ttc'),z*S)
    def text(x,y,t,z=13,c='text',b=False):d.text((round(x*S),round(y*S)),t,font=f(z,b),fill=p[c])
    def length(t,z=13):return d.textlength(t,font=f(z))/S
    def box(x,y,w,h,c='surface',r=0,stroke=None):d.rounded_rectangle((round(x*S),round(y*S),round((x+w)*S),round((y+h)*S)),radius=r*S,fill=p[c],outline=p[stroke] if stroke else None,width=S)
    def line(x,y,w):d.line((x*S,y*S,(x+w)*S,y*S),fill=p['line'],width=S)
    def para(x,y,t,w,z=12):
        row=''
        for ch in t:
            if row and length(row+ch,z)>w:text(x,y,row,z,'muted');y+=22;row=''
            row+=ch
        text(x,y,row,z,'muted');return y+22
    text(18,10,'简约版预览 · 已替换为实测额度模型目录',12,'muted')
    box(0,37,width,45,'surface');text(21,47,'ModMind',17,'accent',True);text(158,52,'设置',12,'muted');line(0,82,width)
    side=0 if narrow else 164
    if side:
        box(0,83,side,800,'panel')
        text(23,107,'创作',11,'muted')
        for i,t in enumerate(['工作台','灵感台','图像工坊','代码','游戏测试']):text(27,140+i*37,t,12)
        text(23,333,'项目',11,'muted')
        for i,t in enumerate(['构建与导出','版本记录','设置']):
            y=366+i*37
            if t=='设置':box(11,y-7,142,32,'selected',5)
            text(27,y,t,12,'accent' if t=='设置' else 'text',t=='设置')
    x=side+(18 if narrow else 36);right=width-(18 if narrow else 36);w=right-x
    tx=x
    for t in ['通用','AI 与图像','开发与构建','集成','关于']:
        text(tx,102,t,12,'accent' if t=='AI 与图像' else 'muted',t=='AI 与图像')
        if t=='AI 与图像':box(tx,130,length(t,12),2,'accent')
        tx+=length(t,12)+(19 if narrow else 28)
    line(side,132,width-side)
    text(x,159,'AI 模型',15,b=True)
    box(right-166,153,166,32,'panel',6);box(right-163,156,73,26,'raised',4)
    text(right-155,162,'ModMind',12,'accent',True);text(right-80,162,'本机 Codex',12,'muted')
    text(x,206,'当前',12,'muted');text(x+33,204,'GPT-5.6 Sol',14)
    text(right-140,206,'消耗 ModMind 额度',12,'muted')
    y=250;tx=x
    for t in ['推荐','GPT','Kimi','GLM','Gemini','Grok']:
        tw=length(t,12)+20
        if tx+tw>right:tx=x;y+=34
        if t=='推荐':box(tx,y-5,tw,28,'selected',5)
        text(tx+10,y,t,12,'accent' if t=='推荐' else 'muted',t=='推荐');tx+=tw+4
    if narrow:
        y+=42;box(x,y-7,w,31,'surface',5,'line');text(x+10,y,'搜索模型',12,'muted');y+=43
    else:
        box(right-139,y-7,139,31,'surface',5,'line');text(right-128,y,'搜索模型',12,'muted');y+=45
    catalog=json.loads((OUT/'active-catalog.json').read_text(encoding='utf8'))
    by_id={m['id']:m for m in catalog['paidModels']}
    models=[(by_id[mid]['name'],by_id[mid]['sentence']) for mid in ['gpt-6.1-sol','gpt-6-astra','gpt-6-luna']]
    line(x,y,w)
    for name,desc in models:
        text(x,y+17,name,14,b=True)
        end=para(x,y+43,desc,w-82)
        box(right-58,y+23,58,30,'surface',5,'line');text(right-41,y+28,'切换',12)
        y=max(y+82,end+16);line(x,y,w)
    text(x,y+34,'>  高级设置',12,'muted');y+=73;line(x,y,w)
    text(x,y+23,'图像服务',14,b=True);text(x+96,y+25,'单独设置图片模型',12,'muted')
    height=y+76
    img=img.crop((0,0,width*S,height*S))
    file=OUT/('simple-'+('narrow' if narrow else 'desktop')+('-dark' if dark else '-light')+'.png')
    img.save(file);print(file.name)
render();render(1100,True);render(480)
