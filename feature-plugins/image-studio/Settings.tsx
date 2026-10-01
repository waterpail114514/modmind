import { useEffect, useRef, useState } from 'react'
import { Save, ShieldCheck, Trash2, WandSparkles } from 'lucide-react'
import type { ImageStudioSettings } from '../../src/shared/imageStudio'
import type { DeviceConnectionState } from '../../src/shared/types'
import { SecretInput } from '../../src/renderer/src/components/SecretInput'
import { useConfirmDialog } from '../../src/renderer/src/components/InteractionDialogs'
import { reportClientFailure as errorMessage } from '../../src/renderer/src/lib/clientFailure'
export default function ImageStudioSettingsPanel({ deviceState, setNotice, onOpenStudio }: { deviceState: DeviceConnectionState; setNotice: (value: string) => void; onOpenStudio: () => void }): React.JSX.Element {
  const { confirm: requestConfirm, dialog } = useConfirmDialog()
  const [imageStudioSettings, setImageStudioSettings] = useState<ImageStudioSettings>({ baseUrl: '', model: '', hasStoredKey: false, allowAgentImages: true, autoApproveAgentImages: true, manualHostedConsent: true })
  const [imageModels, setImageModels] = useState<string[]>([])
  const [imageModelsLoading, setImageModelsLoading] = useState(false)
  const [imageModelsError, setImageModelsError] = useState('')
  const [imageApiKey, setImageApiKey] = useState('')
  const [imageSettingsSaving, setImageSettingsSaving] = useState(false)
  const imageSettingsSavingRef = useRef(false)
  const [imageSettingsFeedback, setImageSettingsFeedback] = useState('')
  useEffect(() => { void window.modmind.imageStudio.getSettings().then(setImageStudioSettings).catch(error => setImageSettingsFeedback(errorMessage(error))) }, [deviceState])
  const refreshImageModels = async (): Promise<void> => {
    setImageModelsLoading(true)
    setImageModelsError('')
    try {
      const capabilities = await window.modmind.imageStudio.capabilities()
      setImageModels(capabilities.models)
      if (!capabilities.models.length) setImageModelsError('服务未返回模型，请检查图像服务配置。')
    } catch (error) {
      setImageModels([])
      setImageModelsError(`模型列表加载失败：${errorMessage(error)}`)
    } finally {
      setImageModelsLoading(false)
    }
  }

  useEffect(() => {
    void refreshImageModels()
  }, [])

  const saveImageSettings = async (patch: Partial<ImageStudioSettings> & { apiKey?: string; clearApiKey?: boolean }): Promise<void> => {
    if (imageSettingsSavingRef.current) return
    imageSettingsSavingRef.current = true
    setImageSettingsSaving(true)
    setImageSettingsFeedback('正在保存…')
    const modelOnly = patch.model !== undefined && patch.apiKey === undefined && !patch.clearApiKey
    try {
      // A model change must not commit an unfinished API address or key.
      const base = modelOnly || patch.clearApiKey ? await window.modmind.imageStudio.getSettings() : imageStudioSettings
      const saved = await window.modmind.imageStudio.saveSettings({ ...base, ...patch, apiKey: modelOnly ? '' : patch.apiKey ?? imageApiKey })
      setImageStudioSettings(current => modelOnly ? { ...current, model: saved.model, hasStoredKey: saved.hasStoredKey } : saved)
      if (patch.apiKey !== undefined) setImageApiKey('')
      const apiDraftPending = modelOnly && (imageStudioSettings.baseUrl !== base.baseUrl || Boolean(imageApiKey))
      const message = modelOnly ? `图片模型已自动保存${apiDraftPending ? '；自定义 API 尚未保存' : ''}` : '图像服务配置已保存'
      if (!modelOnly) setNotice(message)
      setImageSettingsFeedback(message)
      if (!modelOnly) void refreshImageModels()
    } catch (error) {
      setNotice(`图像服务设置保存失败：${errorMessage(error)}`)
      setImageSettingsFeedback('保存失败，请重试；当前设置未更改')
    } finally {
      imageSettingsSavingRef.current = false
      setImageSettingsSaving(false)
    }
  }

  const clearImageApiKey = async (): Promise<void> => {
    if (!await requestConfirm({ title: '删除已保存的图片 API Key？', message: '删除后图像服务将改用 ModMind 托管额度', confirmLabel: '删除 Key', tone: 'danger' })) return
    await saveImageSettings({ apiKey: '', clearApiKey: true })
  }

  return <>
                    <div className="settings-heading"><h2>图像服务</h2></div>
                    {imageStudioSettings.hasStoredKey && deviceState.provider !== 'custom' ? <div className="settings-actions"><button className="secondary-button compact" type="button" disabled={imageSettingsSaving} onClick={() => void clearImageApiKey()}>切换为额度图像服务</button></div> : null}
                    <div className="image-service-form">
                      <label className="field-label">图片模型<select value={imageStudioSettings.model} disabled={imageModelsLoading || imageSettingsSaving || imageStudioSettings.syncedFromDevice} onChange={(event) => void saveImageSettings({ model: event.target.value })}>{!imageModels.includes(imageStudioSettings.model) && <option value={imageStudioSettings.model}>{imageStudioSettings.model ? imageStudioSettings.model + '（当前设置）' : '请选择图片模型'}</option>}{imageModels.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
                      <div className="settings-actions"><button className="secondary-button compact" type="button" disabled={imageModelsLoading || imageSettingsSaving} onClick={() => void refreshImageModels()}>{imageModelsLoading ? '正在加载模型…' : '刷新模型列表'}</button></div>
                    </div>
                    <div className="settings-connection-status" role="status">{imageSettingsFeedback}</div>
                    {imageModelsError && <p role="alert">{imageModelsError}</p>}
                    {imageStudioSettings.syncedFromDevice ? <div className="settings-connection-status">图片 API 已由网页同步</div> : <details>
                      <summary>自定义图像 API（可选）</summary>

                      <div className="image-service-form">
                        <label className="field-label">Base URL<input value={imageStudioSettings.baseUrl} disabled={imageSettingsSaving} onChange={(event) => { setImageStudioSettings({ ...imageStudioSettings, baseUrl: event.target.value }); setImageSettingsFeedback('自定义 API 有未保存的修改') }} /></label>
                        <label className="field-label">图片 API Key<SecretInput aria-label="图片 API Key" secretKey="image" stored={imageStudioSettings.hasStoredKey} value={imageApiKey} disabled={imageSettingsSaving} onChange={(event) => { setImageApiKey(event.target.value); setImageSettingsFeedback('自定义 API 有未保存的修改') }} placeholder={imageStudioSettings.hasStoredKey ? '已安全保存，留空保持不变' : '输入自己的图片 API Key'} /></label>
                        <div className="settings-actions"><span><ShieldCheck size={15} />{imageStudioSettings.hasStoredKey ? '已有加密凭证' : '当前未启用自定义 API'}</span><div className="settings-button-group">{imageStudioSettings.hasStoredKey ? <button className="secondary-button compact danger" type="button" disabled={imageSettingsSaving} onClick={() => void clearImageApiKey()}><Trash2 size={14} />删除已保存 Key</button> : null}<button className="primary-button compact" type="button" disabled={imageSettingsSaving} onClick={() => void saveImageSettings({ apiKey: imageApiKey })}><Save size={14} />{imageSettingsSaving ? '正在保存…' : '保存自定义 API'}</button></div></div>
                      </div>

                    </details>}
                    <div className="settings-actions"><button className="secondary-button compact" type="button" onClick={() => onOpenStudio()}><WandSparkles size={14} />打开图像工坊</button></div>

{dialog}</>
}
