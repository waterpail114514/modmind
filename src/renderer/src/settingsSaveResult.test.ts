import { describe, expect, it } from 'vitest'
import type { AgentSettings } from '../../shared/types'
import { verifySettingsSave } from './settingsSaveResult'

describe('approval settings save acknowledgement', () => {
  it('rejects legacy main-process replies instead of claiming YOLO was saved', () => {
    expect(() => verifySettingsSave({ codexApprovalMode: 'yolo' }, {} as AgentSettings)).toThrow('从系统托盘退出')
  })

  it('rejects an unaccepted mode and accepts both acknowledged modes', () => {
    expect(() => verifySettingsSave({ codexApprovalMode: 'yolo' }, { codexApprovalMode: 'auto-review' } as AgentSettings)).toThrow('未保存成功')
    for (const codexApprovalMode of ['auto-review', 'yolo'] as const) {
      expect(() => verifySettingsSave({ codexApprovalMode }, { codexApprovalMode } as AgentSettings)).not.toThrow()
    }
  })

  it('does not require the new field when saving an unrelated preference', () => {
    expect(() => verifySettingsSave({ darkMode: true }, { darkMode: true } as AgentSettings)).not.toThrow()
  })
})
