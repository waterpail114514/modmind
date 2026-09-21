import { findImageStudioPreset, imageStudioPresetGroups, imageStudioPresets } from '../lib/imageStudioPresets'
import type { WorkflowData } from '../lib/imageWorkflow'

export default function ImagePresetFields({ data, onChange }: { data: WorkflowData; onChange: (patch: Partial<WorkflowData>) => void }): React.JSX.Element {
  const preset = findImageStudioPreset(data.presetId)
  return <>
    <label className="field-label">预设
      <select value={data.presetId || data.style || 'free'} onChange={event => {
        const next = findImageStudioPreset(event.target.value)
        onChange({ presetId: next?.id, presetPrompt: next?.prompt, style: event.target.value === 'minecraft' ? 'minecraft' : 'free' })
      }}>
        <option value="free">自定义（无预设）</option>
        <option value="minecraft">Minecraft 像素风</option>
        {data.presetId && !preset ? <option value={data.presetId}>预设不可用，请重新选择</option> : null}
        {imageStudioPresetGroups.map(group => <optgroup key={group} label={group}>
          {imageStudioPresets.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.label}{item.requiresReference ? ' · 需参考图' : ''}</option>)}
        </optgroup>)}
      </select>
    </label>
    {preset ? <>
      <label className="field-label">预设提示词（可编辑）
        <textarea rows={7} value={data.presetPrompt ?? preset.prompt} onChange={event => onChange({ presetPrompt: event.target.value })} />
      </label>
    </> : null}
  </>
}
