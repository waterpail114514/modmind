import { useEffect, useState } from 'react'
import { Check, CircleAlert, Download, LoaderCircle } from 'lucide-react'
import type { FeaturePageContext } from '../../sdk/renderer'
import type { ShaderInventory, ShaderValidation } from '../../../src/shared/shaderStudio'
import ShaderFrame, { useShaderFeature } from '../../shader-shared/components/ShaderFrame'

export default function ShaderExport(context: FeaturePageContext): React.JSX.Element {
  const feature = useShaderFeature(context, 'shader-export'), { invoke, run, locked, setNotice } = feature
  const [inventory, setInventory] = useState<ShaderInventory>(), [validation, setValidation] = useState<ShaderValidation>()
  const reload = () => run('refresh', async () => { setInventory(await invoke<ShaderInventory>('query', { operation: 'inventory' })); setValidation(undefined) })
  useEffect(() => { if (context.visible) void reload() }, [context.visible, invoke])
  return <ShaderFrame context={context} view="export" feature={feature} refresh={() => void reload()}><div className="shader-delivery">
    <div className="shader-delivery-actions"><button className="secondary-button" disabled={locked} onClick={() => void run('validate', async () => setValidation(await invoke<ShaderValidation>('query', { operation: 'validate' })))}>{feature.busy === 'validate' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}检查光影</button><button className="primary-button" disabled={locked} onClick={() => void run('export', async () => { const result = await invoke<{ path: string; validation: ShaderValidation } | null>('export'); if (result) { setValidation(result.validation); setNotice(`已导出：${result.path}`) } })}><Download size={16} />导出 ZIP</button></div>
    {validation ? <><div className="shader-validation-summary" role="status">{validation.status === 'failed' ? '检查未通过' : '静态检查通过'} · {validation.parsed} 个程序完成语法解析 · {validation.skipped} 个阶段待游戏验证</div>{validation.issues.map((issue, i) => <button key={i} className={`shader-issue ${issue.severity}`} onClick={() => context.openFile(issue.path)}><CircleAlert size={15} /><span><code>{issue.path}{issue.line ? `:${issue.line}` : ''}</code>{issue.message}</span></button>)}</> : <div className="shader-empty">{inventory?.programs.length ?? 0} 个程序 · {inventory?.files.length ?? 0} 个发行文件</div>}
    <div className="shader-status">静态检查不包含实际 OpenGL 编译与游戏画面验证</div>
  </div></ShaderFrame>
}
