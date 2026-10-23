import type { ProjectInfo } from '../../shared/types'
import { resolveStudio, type StudioRecord } from '../../shared/studios'

export type ChatStarterMode = 'workbench' | 'inspiration'
export interface ChatStarter { title: string; prompt: string }

export function createChatStarters(mode: ChatStarterMode, project?: ProjectInfo, records: StudioRecord[] = []): { greeting: string; suggestions: ChatStarter[] } {
  const studio = project ? resolveStudio(records, project) : undefined
  const profile = studio?.available ? studio.definition.ai[mode] : undefined
  const greetings = profile?.greetings ?? [mode === 'workbench' ? '今天想做什么样的作品？' : '先聊聊你的点子。']
  const pool: ChatStarter[] = (profile?.starters ?? [
    { title: '从一个点子开始', prompt: '我想创作一个 Minecraft 作品，帮我明确目标和适合的作品类型。' },
    { title: '比较几个方向', prompt: '结合我的目标，比较几个创作方向与实现成本。' },
    { title: '整理已有想法', prompt: '帮我把已有想法整理成目标、限制和待验证问题。' }
  ]).map(value => ({ ...value }))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return { greeting: greetings[Math.floor(Math.random() * greetings.length)], suggestions: pool.slice(0, 3) }
}
