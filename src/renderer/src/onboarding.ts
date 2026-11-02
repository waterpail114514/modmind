import { useCallback, useState } from 'react'
import { featureBundles } from './featureInstallPlan'
import type { FeatureStoreEntry } from '../../shared/featureStore'
import type { FeaturePluginCatalogEntry } from '../../shared/featurePlugins'

export const ONBOARDING_KEY = 'modmind-onboarding:v1'
export const onboardingGoals = [
  { id: 'mod', name: '制作 Mod', example: '添加自己的物品、方块或玩法', studioId: 'minecraft-mod', featureId: 'studio-mod' },
  { id: 'modpack', name: '制作整合包', example: '组合模组，设计任务与游玩体验', studioId: 'minecraft-modpack', featureId: 'studio-modpack' },
  { id: 'server', name: '开发服务端插件', example: '给服务器添加指令、规则与奖励', studioId: 'minecraft-server-plugin', featureId: 'studio-server-plugin' },
  { id: 'shader', name: '制作光影', example: '修改光照、水面与画面效果', studioId: 'minecraft-shader', featureId: 'studio-shader' }
] as const
export type OnboardingGoal = typeof onboardingGoals[number]['id']
export const onboardingTasks: Record<OnboardingGoal, Array<{ id: string; name: string; featureId?: string; view: string; result: string }>> = {
  mod: [
    { id: 'item', name: '准备制作第一个物品', featureId: 'item-editor', view: 'item-editor', result: '物品与装备工具已打开，可以开始创建物品。' },
    { id: 'idea', name: '让 AI 帮我实现一个玩法', view: 'workspace', result: '工作台已打开，连接账号后即可描述你的玩法。' }
  ],
  modpack: [
    { id: 'mods', name: '准备添加模组', featureId: 'modpack-mods', view: 'third-party-mods', result: '模组下载工具已打开，可以查找并添加模组。' },
    { id: 'quests', name: '准备制作任务书', featureId: 'ftb-quests', view: 'ftb-quests', result: 'FTB 任务书工具已打开，可以开始编排任务。' }
  ],
  server: [
    { id: 'command', name: '让 AI 帮我制作一条指令', view: 'workspace', result: '工作台已打开，连接账号后即可描述你的指令。' },
    { id: 'test', name: '找到服务端测试工具', featureId: 'testing', view: 'modpack-server', result: '服务端测试工具已打开；实际启动时再准备运行资源。' }
  ],
  shader: [
    { id: 'source', name: '查看和编辑光影源码', featureId: 'shader-source', view: 'shader-source', result: '光影源码工具已打开，可以开始查看和编辑。' },
    { id: 'options', name: '调整光影选项', featureId: 'shader-options', view: 'shader-options', result: '光影选项工具已打开，可以开始调整选项。' }
  ]
}

export function onboardingRequiredFeatures(goalId?: OnboardingGoal, taskId?: string): string[] {
  const goal = onboardingGoals.find(value => value.id === goalId)
  if (!goal) return []
  const task = onboardingTasks[goal.id].find(value => value.id === taskId)
  return [...new Set([goal.featureId, ...(featureBundles.find(bundle => bundle.id === goal.id)?.ids ?? []), ...(task?.featureId ? [task.featureId] : [])])]
}

export function pendingOnboardingFeatures(required: string[], entries: FeatureStoreEntry[], catalog: FeaturePluginCatalogEntry[], modules: Record<string, unknown>): string[] {
  return required.filter(id => {
    const entry = entries.find(value => value.id === id)
    const renderer = catalog.find(value => value.id === id)
    return !entry?.available || Boolean(entry.updateAvailable) || !renderer?.available || renderer.version !== entry.version || !modules[id]
  })
}
export const onboardingPhases = ['experience', 'goal', 'task', 'features', 'locate', 'install', 'create', 'studio', 'field', 'submit', 'tool', 'complete', 'import', 'handoff', 'inspiration'] as const
export type OnboardingPhase = typeof onboardingPhases[number]
export const onboardingIntroSteps = ['hello', 'experience', 'new', 'returning', 'checking', 'account', 'helper', 'helpers', 'model', 'modelReply', 'invitation'] as const
export type OnboardingIntroStep = typeof onboardingIntroSteps[number]
export type OnboardingModelChoice = 'sol' | 'deepseek'
export interface OnboardingSession {
  version: 1
  status: 'running' | 'paused' | 'skipped' | 'done'
  phase: OnboardingPhase
  goal?: OnboardingGoal
  task?: string
  fieldIndex: number
  projectPath?: string
  introStep?: OnboardingIntroStep
  experience?: 'new' | 'returning'
  modelChoice?: OnboardingModelChoice
  inspirationConversationId?: string
  projectMode?: 'new' | 'existing'
  importSourcePath?: string
  projectDraft?: Record<string, string>
}
export const freshOnboarding = (): OnboardingSession => ({ version: 1, status: 'running', phase: 'experience', fieldIndex: 0 })

export function parseOnboarding(raw: string | null): OnboardingSession {
  try {
    const value = JSON.parse(raw ?? 'null') as OnboardingSession | null
    if (!value || value.version !== 1 || !['running', 'paused', 'skipped', 'done'].includes(value.status) || !onboardingPhases.includes(value.phase)) return freshOnboarding()
    if (value.goal && !onboardingGoals.some(goal => goal.id === value.goal)) return freshOnboarding()
    if (value.phase !== 'import' && onboardingPhases.indexOf(value.phase) >= 2 && !value.goal) return freshOnboarding()
    if (value.task && (!value.goal || !onboardingTasks[value.goal].some(task => task.id === value.task))) return freshOnboarding()
    if (value.phase !== 'import' && onboardingPhases.indexOf(value.phase) >= 3 && (!value.goal || !value.task)) return freshOnboarding()
    return { ...value, fieldIndex: Number.isSafeInteger(value.fieldIndex) && value.fieldIndex >= 0 ? Math.min(value.fieldIndex, 32) : 0, projectPath: typeof value.projectPath === 'string' ? value.projectPath : undefined,
      introStep: value.introStep === 'modelReply' && !['sol', 'deepseek'].includes(value.modelChoice!) ? 'model' : onboardingIntroSteps.includes(value.introStep!) ? value.introStep : undefined,
      experience: value.experience === 'new' || value.experience === 'returning' ? value.experience : undefined,
      modelChoice: value.modelChoice === 'sol' || value.modelChoice === 'deepseek' ? value.modelChoice : undefined,
      inspirationConversationId: typeof value.inspirationConversationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.inspirationConversationId) ? value.inspirationConversationId : undefined,
      projectMode: value.phase === 'import' || value.projectMode === 'existing' ? 'existing' : value.projectMode === 'new' ? 'new' : undefined,
      importSourcePath: typeof value.importSourcePath === 'string' ? value.importSourcePath : undefined,
      projectDraft: value.projectDraft && typeof value.projectDraft === 'object' && !Array.isArray(value.projectDraft) ? Object.fromEntries(Object.entries(value.projectDraft).filter(([key, field]) => key.length <= 80 && typeof field === 'string' && field.length <= 1024).slice(0, 32)) : undefined }
  } catch { return freshOnboarding() }
}

export function resumeOnboarding(session: OnboardingSession, currentPath?: string): OnboardingSession {
  // Always revisit the complete recommendation; preserve a matching created project.
  const reselectExisting = session.projectMode === 'existing' && (!session.projectPath || session.projectPath !== currentPath)
  return { ...session, status: 'running', phase: ['handoff', 'inspiration'].includes(session.phase) && session.projectPath === currentPath ? 'handoff' : session.phase === 'experience' ? 'experience' : reselectExisting || session.phase === 'import' ? 'import' : session.goal && session.task ? 'features' : session.goal ? 'task' : 'goal', fieldIndex: 0, projectPath: session.projectPath === currentPath ? session.projectPath : undefined }
}

export function onboardingGoalForProject(project: { studioId?: string; kind?: string }): OnboardingGoal | undefined {
  if (project.studioId) return onboardingGoals.find(goal => goal.studioId === project.studioId)?.id
  switch (project.kind ?? 'mod') {
    case 'mod': return 'mod'
    case 'modpack': return 'modpack'
    case 'server-plugin': return 'server'
    case 'shader': return 'shader'
    default: return undefined
  }
}

export function useOnboardingSession() {
  const [session, setSession] = useState<OnboardingSession>(() => {
    try {
      const saved = parseOnboarding(localStorage.getItem(ONBOARDING_KEY))
      return saved.status === 'running' && saved.phase !== 'experience' ? { ...saved, status: 'paused' as const } : saved
    } catch { return freshOnboarding() }
  })
  const update = useCallback((patch: Partial<OnboardingSession>) => {
    setSession(current => {
      const next = { ...current, ...patch }
      try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next)) } catch { /* Continue in memory when storage is unavailable. */ }
      return next
    })
  }, [])
  const restart = useCallback(() => {
    const next = freshOnboarding()
    try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next)) } catch { /* Continue in memory. */ }
    setSession(next)
  }, [])
  return { session, update, restart }
}
