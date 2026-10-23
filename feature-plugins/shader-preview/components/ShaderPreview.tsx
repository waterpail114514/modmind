import { useEffect, useState } from 'react'
import type { FeaturePageContext } from '../../sdk/renderer'
import ShaderFrame, { useShaderFeature } from '../../shader-shared/components/ShaderFrame'
import FinalPreview from './FinalPreview'

export default function ShaderPreview(context: FeaturePageContext): React.JSX.Element {
  const feature = useShaderFeature(context, 'shader-preview'), [preview, setPreview] = useState('')
  const reload = () => feature.run('refresh', async () => setPreview((await feature.invoke<{ source: string }>('query', { operation: 'preview' })).source))
  useEffect(() => { if (context.visible) void reload() }, [context.visible, feature.invoke])
  return <ShaderFrame context={context} view="preview" feature={feature} refresh={() => void reload()}>
    {preview ? <FinalPreview source={preview} /> : <div className="shader-empty">{feature.busy ? '正在读取 final 程序' : '没有可预览的 final 程序'}<button className="secondary-button compact" onClick={() => context.hasPage('shader-test') ? context.navigate('shader-test') : context.navigate('features')}>{context.hasPage('shader-test') ? '游戏验证' : '安装游戏验证'}</button></div>}
  </ShaderFrame>
}
