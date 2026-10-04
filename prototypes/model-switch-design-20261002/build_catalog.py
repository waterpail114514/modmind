from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import json,re
root=Path(__file__).parent
probe=root/'route-probe'
providers=json.loads((probe/'providers.json').read_text(encoding='utf8'))['providers']
providers=[p for p in providers if p['account']!='primary']
routes=[]
for file in probe.glob('*.json'):
    d=json.loads(file.read_text(encoding='utf8'))
    if 'modelIds' in d and d.get('account')!='primary':routes.append(d)
routes.sort(key=lambda r:(r['account']!='secondary',r['account'],r['group'] or ''))
paid=sorted({m for r in routes if r['account']=='secondary' for m in r['modelIds'] if m!='codex-auto-review'})
free=sorted({m for r in routes if r['account'].startswith('trial:') for m in r['modelIds']})
source=Path('C:/Users/waterpail/.codex/visualizations/2026/10/01/01a0f899-35c2-7351-a1e1-7afcf0a3c429/model-switch-simple.html').read_text(encoding='utf8')
copies={m[0]:{'name':m[1],'family':m[2],'sentence':m[3]} for m in re.findall(r"\['([^']+)','([^']+)','([^']+)','([^']+)'",source)}
freecopies={
 'deepseek-v4-pro-0813':'推理型模型，适合代码分析、复杂问题和排错。',
 'deepseek-v4.1-flash':'轻快的模型，适合配方、配置和小脚本。',
 'glm-5.3':'中文友好的模型，适合需求讨论、写代码和开发规划。',
 'qwen3.8-flash':'轻量通用模型，适合文本整理和代码小改动。',
 'nvidia/nemotron-3-ultra-550b-a55b:free':'通用模型，适合讨论思路、整理资料和分析问题。'
}
assert len(paid)==17 and all(m in copies for m in paid)
out={'checkedDate':'2026-10-02','excludedAccounts':['primary'],'scope':'本次授权账号可见的供应商 2 与免费套餐；目录验证，未执行收费推理','providers':providers,'routes':routes,'paidModelCount':len(paid),'paidModels':[{'id':m,**copies[m]} for m in paid],'freeModels':[{'id':m,'sentence':freecopies[m],'loginOnly':m.startswith('nvidia/')} for m in free],'internalModelIds':['codex-auto-review']}
(root/'active-catalog.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
lines=['# 简约模型切换：实测结果与文案','',
'2026-10-02，已使用授权账号逐条切换并查询 `/v1/models`，排除用户明确废弃的供应商 1。全程未发起模型推理。原供应商 2 的更稳定 C 分组已恢复，开发客户端凭据已同步，最后一次 `/models` 回查成功。','',
'## 页面','',
'保留模型来源、当前模型、家族筛选与搜索。每行只有型号、一句定位与适用任务说明和“切换”按钮。去掉独立详情栏、型号图标、大号标题和常驻线路说明；高级设置折叠。','',
'额度选择器只放 17 个普通付费模型。免费模型另列，不自动混进消耗额度模式。`codex-auto-review` 保留为目录中的专用 ID，不作为普通模型推荐。','',
'## 供应商与线路','',
'供应商 2 的上游标签为 `供应商 2（sub2API）`，有 8 个分组；另外 2 个免费套餐无子分组。价格百分比来自上游线路名称，未独立验证最终账单，不能当成不同模型之间统一的成本倍率。','',
'| 供应商 / 套餐 | 线路名称（上游原文） | 返回的模型 ID 数 |','| --- | --- | --- |']
for p in providers:
    if p['kind']=='paid':
        for g in p['groups']:
            r=next(x for x in routes if x['account']==p['account'] and x['group']==g['id'])
            lines.append(f"| {p['label']} | {g['label']} | {r['modelCount']} |")
    else:
        r=next(x for x in routes if x['account']==p['account'])
        lines.append(f"| {p['label']} | 无子分组 | {r['modelCount']} |")
lines+=['','数量包含目录中列出的专用 ID；“仅做登录用”套餐虽列出一个模型，但上游明确标注无额度，不作为可用免费推荐。','',
'## 17 个付费模型的一句话文案','',
'按用户确认的适配范围编写简短推荐语：直接介绍模型定位和适用任务，仅在明确有上位替代的旧型号中提示替代选择。适配顾虑、一般性负面描述不进入模型推荐语；账号可用性仍按真实状态单独显示。','',
'| 型号 ID | 一句话推荐语 |','| --- | --- |']
for m in paid:lines.append(f"| `{m}` | {copies[m]['sentence']} |")
lines+=['','## 免费套餐目录','', 'Nemotron 所在套餐仍为“仅登录、无额度”；这是套餐状态，与模型推荐语分开记录。','', '| 型号 ID | 一句话推荐语 |','| --- | --- |']
for m in free:lines.append(f'| `{m}` | {freecopies[m]} |')
lines+=['','## 每条线路的完整模型映射','']
for p in providers:
    rs=[r for r in routes if r['account']==p['account']]
    for r in rs:
        label=next((g['label'] for g in p['groups'] if g['id']==r['group']),p['label'])
        lines +=[f"### {p['account']} / {label}",'',f"分组 ID：`{r['group'] or 'null'}`",'',', '.join('`'+m+'`' for m in r['modelIds']),'']
lines+=['## 实测中的恢复情况','',
'首次跨供应商切换出现一次 502；按附件先回读状态，确认仍在供应商 2 后恢复，再重试成功。用户随后明确供应商 1 已废弃，已从最终目录和探测脚本目标中排除。此前的原始响应仅留作本地审计，不参与模型推荐。','',
'跨供应商时 Key 确实可能变化，开发窗口可能仍持有旧 Key。已通过同一 Electron safeStorage 格式恢复最新账号凭据，并核对账号 Key 匹配，未启动额外开发窗口。线路探测会话在完成后撤销，不撤销模型 Key。','',
'静态浅色、深色与窄窗口设计图已生成；交互稿通过 JavaScript 语法检查。浏览器权限校验问题仍未解决，未宣称完成实际浏览器点击验收。生产设置页面和 MCP 接口尚未实现。']
(root/'简约版实测清单.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
print(json.dumps({'paid':len(paid),'freeListed':len(free),'routes':len(routes),'families':sorted({copies[m]['family'] for m in paid})}))
