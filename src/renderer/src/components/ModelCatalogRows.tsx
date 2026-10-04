import { Check, LoaderCircle } from 'lucide-react'
import type { AiModelInfo } from '../../../shared/types'
import { quotaModelMetadata, quotaModelOptionKey } from '../../../shared/quotaModels'

export function modelCatalogKey(model: AiModelInfo): string { return model.optionKey ?? model.id }
export function modelCatalogFamilies(models: AiModelInfo[]): string[] {
  const order=['GPT','Kimi','GLM','Gemini','Grok','DeepSeek','Qwen']
  const families=[...new Set(models.map(m=>quotaModelMetadata(m.id).family))].sort((a,b)=>(order.indexOf(a)<0?99:order.indexOf(a))-(order.indexOf(b)<0?99:order.indexOf(b)))
  return ['推荐',...families,'全部','免费']
}
export function filterModelCatalog(models: AiModelInfo[], family: string, query: string, currentKey?: string): AiModelInfo[] {
  const search=query.trim().toLowerCase()
  const recommended=models.some(m=>quotaModelMetadata(m.id).recommended)
  return models.filter(m=>search?`${m.id} ${quotaModelMetadata(m.id).name} ${m.providerLabel??''}`.toLowerCase().includes(search):family==='全部'?true:family==='免费'?m.billing==='free':family==='推荐'?quotaModelMetadata(m.id).recommended||!recommended:quotaModelMetadata(m.id).family===family)
    .sort((a,b)=>{
      const order=['gpt-6.1-sol','gpt-6-astra','gpt-6-luna','deepseek-v4.1-flash']
      const rank=(id:string)=>order.indexOf(id)<0?99:order.indexOf(id)
      return rank(a.id)-rank(b.id)||quotaModelMetadata(b.id).name.localeCompare(quotaModelMetadata(a.id).name,'zh-CN',{numeric:true})||String(a.account).localeCompare(String(b.account))
    })
}
export default function ModelCatalogRows({ models, currentKey, switchingKey, disabled, compact, onSelect }: {
  models: AiModelInfo[]; currentKey?: string; switchingKey?: string | null; disabled?: boolean; compact?: boolean; onSelect: (model: AiModelInfo) => void
}): React.JSX.Element {
  return <div className={`model-catalog-rows${compact?' is-compact':''}`} role="group" aria-label="可用模型">{models.map(model=>{
    const selected=modelCatalogKey(model)===currentKey, switching=modelCatalogKey(model)===switchingKey
    const metadata=quotaModelMetadata(model.id)
    return <button type="button" key={modelCatalogKey(model)} className={`model-catalog-option${compact?'':' quota-model-row'}`} data-option-key={modelCatalogKey(model)} aria-label={`切换到 ${metadata.name}${model.billing==='free'?' 免费版':''}${model.providerLabel?` · ${model.providerLabel}`:''}`} aria-pressed={selected} disabled={disabled||model.available===false} title={model.unavailableReason} onClick={()=>onSelect(model)}>
      <span className="model-catalog-copy"><strong>{metadata.name}</strong>{model.providerLabel?<small>{model.providerLabel}</small>:null}{!compact&&metadata.description?<span>{metadata.description}</span>:null}</span>
      {model.billing?<span className={`model-catalog-billing${model.billing==='free'?' quota-free-mark':''}`}>{model.billing==='free'?'免费':'额度'}</span>:null}
      {'noCache' in model&&model.noCache?<span className="model-catalog-no-cache quota-no-cache-mark">无缓存</span>:null}
      <span className="model-catalog-check">{switching?<LoaderCircle size={14} className="spin"/>:selected?<Check size={14}/>:null}</span>
    </button>
  })}{!models.length?<div className="model-catalog-empty">没有匹配的模型</div>:null}</div>
}
export function selectedCatalogKey(model:string,account?:string,billing?:'quota'|'free'):string { return account?quotaModelOptionKey(model,billing??'quota',account):model }
