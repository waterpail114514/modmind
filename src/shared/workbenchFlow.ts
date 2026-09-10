import type { AiCreateCodeOptions, CodingBackend, ProjectInfo } from './types'
import { draftProjectContext } from './draftProject'
import { DISCUSSION_CHOICES_INSTRUCTION } from './discussionChoices'

/** Keep project ownership and cancellation on the workspace while reusing the read-only inspiration runner. */
export function usesInspirationWorkflow(options: AiCreateCodeOptions): boolean {
  return options.surface === 'inspiration' || options.workbenchPhase === 'discussion'
}

export function workbenchFlowOptions(discussion: boolean): Pick<AiCreateCodeOptions, 'surface' | 'workbenchPhase'> {
  return { surface: 'workspace', ...(discussion ? { workbenchPhase: 'discussion' as const } : {}) }
}

export function workbenchFlowBackend(mode: 'beginner' | 'advanced', configured: CodingBackend, engineeringHandoff: boolean): CodingBackend {
  return mode === 'beginner' || engineeringHandoff ? 'quota' : configured
}

export function discussionPrompt(request: string, context: string, project: Pick<ProjectInfo, 'name' | 'loader' | 'minecraftVersion' | 'draft'>): string {
  return `你正在灵感台的快速只读问答阶段。用简体中文直接回答，先理解需求和给出可执行的方案；仅在缺少影响结果的信息时追问，一次一个问题。不要写文件、安装、构建或运行测试，也不要声称已经完成制作。用户通过对话里的制作选项明确交给工程阶段。\n${draftProjectContext(project)}\n${context ? `\n最近对话：\n${context}\n` : ''}\n用户最新请求：\n${request}\n\n${DISCUSSION_CHOICES_INSTRUCTION}`
}

export function engineeringHandoffPrompt(context: string): string {
  return `用户已点击“开始制作”。请根据下面的完整对话实施用户认可的方案，继续使用当前项目，先检查已有实现。讨论中的建议不等于已完成的修改；不要把未选择的互斥方案全部实施。按工作台工程流程完成修改、构建和验证；仍缺少必要信息时先追问，不要猜测。\n\n${context}`
}
