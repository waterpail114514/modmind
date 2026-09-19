export const WORKBENCH_FEATURES = [
  { id: 'renderedTesting', label: '真实界面测试' },
  { id: 'headlessTesting', label: '无头测试' },
  { id: 'imageGeneration', label: 'AI 生图' },
  { id: 'modeling', label: 'Blockbench 建模' }
] as const

export type WorkbenchFeature = typeof WORKBENCH_FEATURES[number]['id']
export type WorkbenchFeatures = Record<WorkbenchFeature, boolean>

export const DEFAULT_WORKBENCH_FEATURES: WorkbenchFeatures = { renderedTesting: true, headlessTesting: true, imageGeneration: true, modeling: true }

export function readWorkbenchFeatureSelection(saved: string | null): WorkbenchFeatures {
  if (saved === null) return { ...DEFAULT_WORKBENCH_FEATURES }
  try { return normalizeWorkbenchFeatures(JSON.parse(saved)) }
  catch { return { ...DEFAULT_WORKBENCH_FEATURES } }
}

export function normalizeWorkbenchFeatures(value: unknown): WorkbenchFeatures {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(WORKBENCH_FEATURES.map(({ id }) => [id, source[id] === true])) as WorkbenchFeatures
}

export function disabledWorkbenchFeature(features: WorkbenchFeatures | undefined, action: string, input: Record<string, unknown> = {}): WorkbenchFeature | undefined {
  if (!features) return undefined
  if (action === 'test_rendered' && !features.renderedTesting) return 'renderedTesting'
  if ((action.startsWith('blockbench_') || action.startsWith('asset_')) && !features.modeling) return 'modeling'
  if (['image_generate', 'image_perfect_pixel', 'image_remove_background'].includes(action) && !features.imageGeneration) return 'imageGeneration'
  if (action === 'test_session' && ['stop', 'state', 'capabilities'].includes(String(input.operation))) return undefined
  if (action === 'test_session' && input.operation === 'start') {
    if (input.mode === 'rendered' && !features.renderedTesting) return 'renderedTesting'
    if (input.mode === 'headless' && !features.headlessTesting) return 'headlessTesting'
  }
  if (action === 'test_capture' && !features.renderedTesting) return 'renderedTesting'
  if (['test_session', 'test_observe', 'test_action', 'test_scenario'].includes(action) && !features.renderedTesting && !features.headlessTesting) return 'headlessTesting'
  if (action === 'test_matrix' && (!Array.isArray(input.targets) || input.targets.some(target => target !== 'build')) && !features.headlessTesting) return 'headlessTesting'
  if (['test_minecraft', 'modpack_verify_server_join', 'modpack_run_server_scenario'].includes(action) && !features.headlessTesting) return 'headlessTesting'
  if (action === 'server_operation' && !['state', 'logs', 'stop'].includes(String(input.operation)) && !features.headlessTesting && !features.renderedTesting) return 'headlessTesting'
  return undefined
}

export function hiddenWorkbenchToolPrefixes(features?: WorkbenchFeatures): string[] {
  if (!features) return []
  return [
    ...(!features.modeling ? ['modmind_blockbench_', 'modmind_asset_'] : []),
    ...(!features.imageGeneration ? ['modmind_image_generate', 'modmind_image_perfect_pixel', 'modmind_image_remove_background'] : []),
    ...(!features.headlessTesting ? ['modmind_test_minecraft', 'modmind_modpack_verify_server_join', 'modmind_modpack_run_server_scenario'] : []),
    ...(!features.renderedTesting ? ['modmind_test_capture', 'modmind_test_rendered'] : []),
    ...(!features.renderedTesting && !features.headlessTesting ? ['modmind_test_session', 'modmind_test_observe', 'modmind_test_action', 'modmind_test_scenario'] : [])
  ]
}

export function workbenchFeatureUnavailable(feature: WorkbenchFeature): string {
  return `用户未勾选「${WORKBENCH_FEATURES.find(item => item.id === feature)!.label}」，本轮不开放该功能。需要时建议用户在专业模式对话框的「制作功能」中勾选，然后重新发送指令；不得自行开启或通过命令、插件、其他工具绕过。`
}

export function workbenchFeaturePrompt(features?: WorkbenchFeatures): string {
  if (!features) return ''
  return `本轮制作功能（用户勾选决定是否开放）：
${WORKBENCH_FEATURES.map(({ id, label }) => `- ${label}：${features[id] ? '已勾选' : '未勾选，不可使用'}`).join('\n')}
用户要求制作时，应使用已勾选且适用于当前任务的功能，不要仅口头承诺；简单问答不启动制作或测试。选中测试后，在本轮相关制作完成后执行对应测试并报告证据；项目或版本不支持时说明实际限制，不能冒充已验证。真实界面测试允许显示游戏窗口，使用 rendered 模式；无头测试使用 headless 模式，不能替代真实画面验收。
skill 可能描述本轮未开放的工具；对照此清单，未勾选就是未开放，不是安装损坏或审批服务故障。建议用户在专业模式对话框的「制作功能」中勾选对应项，再发送指令。禁止自行修改勾选、借助原生命令、插件或委派绕过未勾选功能。对已勾选却仍不可用的工具，应说明真实错误，不要误称用户未勾选。
普通源码编辑、内容读取和构建仍按任务需要进行。不得因为 skill 建议测试就启动未勾选的测试。恢复、重试、分叉和切换引擎时以本轮清单为准。`
}
