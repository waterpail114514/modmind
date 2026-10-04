"""Draw a static UI concept, not a browser/application screenshot."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
SCALE = 2
FONT = 'C:/Windows/Fonts/msyh.ttc'
BOLD = 'C:/Windows/Fonts/msyhbd.ttc'

def render(width=1280, dark=False):
    narrow = width < 600
    height = 1450 if narrow else 1100
    p = dict(canvas='#f5f6f7', panel='#eceef0', surface='#f9fafb', raised='#ffffff', text='#2e3843', muted='#626970', line='#dce0e4', action='#1e5a60', accent='#1e5a60', selected='#e1e6e8')
    if dark:
        p.update(canvas='#23272b', panel='#282d32', surface='#2e343a', raised='#363d44', text='#e8ecef', muted='#aeb7bf', line='#404950', accent='#84c4c4', selected='#384249')
    img = Image.new('RGB', (width*SCALE, height*SCALE), p['canvas'])
    d = ImageDraw.Draw(img)
    fonts = {}
    def font(size, bold=False):
        key=(size,bold)
        if key not in fonts: fonts[key] = ImageFont.truetype(BOLD if bold else FONT, size*SCALE)
        return fonts[key]
    def text(x,y,s,size=14,color='text',bold=False):
        d.text((int(x*SCALE),int(y*SCALE)),s,font=font(size,bold),fill=p.get(color,color))
    def measure(s,size=14,bold=False):
        return d.textlength(s,font=font(size,bold))/SCALE
    def box(x,y,w,h,fill='surface',radius=0,outline=None):
        r=(int(x*SCALE),int(y*SCALE),int((x+w)*SCALE),int((y+h)*SCALE))
        d.rounded_rectangle(r,radius=int(radius*SCALE),fill=p.get(fill,fill),outline=p.get(outline,outline) if outline else None,width=SCALE)
    def line(x1,y1,x2,y2):
        d.line((int(x1*SCALE),int(y1*SCALE),int(x2*SCALE),int(y2*SCALE)),fill=p['line'],width=SCALE)
    def paragraph(x,y,s,maxw,size=14,color='text',lineheight=24):
        row=''; yy=y
        for char in s:
            if row and measure(row+char,size)>maxw:
                text(x,yy,row,size,color);yy+=lineheight;row=''
            row+=char
        if row:text(x,yy,row,size,color)
        return yy+lineheight
    # Preview annotation is deliberately outside the depicted application.
    text(20,10,'设置页设计预览 · 示例型号，待上游目录确认',12,'muted')
    header=38
    box(0,header,width,50,'surface')
    box(20,header+13,24,24,'action',6)
    text(26,header+14,'M',15,'#ffffff',True)
    text(53,header+12,'ModMind',18,'accent',True)
    if not narrow:text(187,header+17,'设置',12,'muted')
    text(width-143,header+17,'ModMind 账号',12,'muted')
    line(0,header+50,width,header+50)
    side=0 if narrow else 194
    if side:
        box(0,88,side,height-88,'panel')
        line(side,88,side,height)
        text(24,111,'创作',12,'muted')
        for i,label in enumerate(['工作台','灵感台','图像工坊','代码','游戏测试']):text(28,148+i*44,label,14)
        text(24,390,'项目',12,'muted')
        for i,label in enumerate(['构建与导出','版本记录','设置']):
            y=429+i*44
            if label=='设置':box(12,y-8,170,37,'selected',6)
            text(28,y,label,14,'accent' if label=='设置' else 'text',label=='设置')
        line(22,791,172,791)
        text(27,814,'我的模组',13,bold=True)
        text(27,838,'Fabric · 1.21.1',11,'muted')
    left=side+(20 if narrow else 40);right=width-(20 if narrow else 40);cw=right-left
    tabs=['通用','AI 与图像','开发与构建','集成','关于'];x=left
    for label in tabs:
        text(x,108,label,12,'accent' if label=='AI 与图像' else 'muted',label=='AI 与图像')
        tw=measure(label,12)
        if label=='AI 与图像':box(x,140,tw,2,'accent')
        x+=tw+(22 if narrow else 30)
    line(side,142,width,142)
    text(left,166,'AI 模型',16,bold=True)
    sourcew=177 if not narrow else 165
    box(right-sourcew,161,sourcew,36,'panel',7)
    box(right-sourcew+3,164,76,30,'raised',5)
    text(right-sourcew+11,170,'ModMind',12,'accent',True)
    text(right-85,170,'本机 Codex',12,'muted')
    text(left,218,'当前使用',12,'muted')
    text(left,242,'GPT-5.6 Sol',20,bold=True)
    box(left+146,246,53,23,'selected',4);text(left+153,249,'已启用',11,'accent')
    chargey=280 if narrow else 246
    text(left if narrow else right-170,chargey,'消耗 ModMind 额度',12,'muted')
    divider=318 if narrow else 287
    line(left,divider,right,divider)
    heading=divider+26
    text(left,heading,'更换模型',15,bold=True)
    box(right-172,heading-6,172,33,'surface',6,'line')
    text(right-159,heading+2,'搜索模型',12,'muted')
    famy=heading+48;x=left
    for label in ['推荐','GPT','Claude','Gemini','DeepSeek','更多家族']:
        fw=measure(label,12)+22
        if x+fw>right:x=left;famy+=36
        if label=='推荐':box(x,famy-4,fw,29,'selected',6)
        text(x+11,famy+2,label,12,'accent' if label=='推荐' else 'muted',label=='推荐')
        x+=fw+6
    top=famy+49
    listw=cw if narrow else 487
    models=[('G','GPT-6.1 Sol','日常开发的起点'),('C','Claude Sonnet 4.6','读懂代码，再做修改'),('D','DeepSeek V4 Flash','配方、配置与简单脚本')]
    rh=87 if narrow else 100
    for i,(mark,name,pitch) in enumerate(models):
        y=top+i*(rh+4)
        if i==0:box(left,y,listw,rh,'selected',9)
        box(left+16,y+26,33,33,'surface',8,'accent' if i==0 else 'line')
        text(left+27,y+33,mark,13,'accent' if i==0 else 'muted',True)
        text(left+65,y+21,name,15,bold=True)
        text(left+65,y+49,pitch,13,'muted')
        if i==0:text(left+listw-43,y+35,'已选',11,'accent')
    if narrow:
        dt=top+3*(rh+4)+22;dx=left;dw=cw
        line(left,dt-15,right,dt-15)
    else:
        dt=top;dx=left+listw+44;dw=right-dx
        line(dx-23,dt,dx-23,dt+355)
    text(dx,dt+2,'GPT 家族',12,'muted');text(right-27,dt+2,'示例',11,'muted')
    text(dx,dt+30,'GPT-6.1 Sol',22,bold=True)
    text(dx,dt+67,'日常开发的起点',13,'muted')
    text(dx,dt+105,'适合',12,'accent',True)
    y=paragraph(dx,dt+130,'写功能、修报错、改配置；不知道选哪个时，可先从它开始。',dw,14)
    text(dx,y+10,'−  不建议',12,'muted',True)
    y=paragraph(dx,y+35,'只改几行文本时不必优先选；复杂疑难任务可考虑 Astra。',dw,14)
    line(dx,y+14,right,y+14)
    text(dx,y+27,'额度消耗',12,'muted');text(right-72,y+27,'价格待同步',12,'muted')
    text(dx,y+58,'选择后自动连接可用线路',12,'muted')
    box(dx,y+87,dw,42,'action',7)
    button='使用此模型  →';text(dx+(dw-measure(button,14))/2,y+97,button,14,'#ffffff')
    bottom=y+153
    line(left,bottom,right,bottom)
    text(left,bottom+18,'>  高级设置',12,'muted')
    line(left,bottom+53,right,bottom+53)
    text(left,bottom+73,'图像服务',14,bold=True)
    text(left+88,bottom+75,'独立选择图片生成模型',12,'muted')
    actual_height=bottom+113
    img=img.crop((0,0,width*SCALE,actual_height*SCALE))
    name=('narrow' if narrow else 'desktop')+('-dark' if dark else '-light')+'.png'
    img.save(OUT/name)
    print(f'{name}: {width} × {actual_height}')

if __name__=='__main__':
    render()
    render(1280,True)
    render(480)
