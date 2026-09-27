import type { AiCreateCodeOptions, CodingBackend, ProjectInfo } from './types'
import { draftProjectContext } from './draftProject'
import { DISCUSSION_CHOICES_INSTRUCTION } from './discussionChoices'

export const WORKBENCH_REQUEST_GUIDANCE = `当前在工作台承接用户请求，由你根据当前请求和已有对话决定回答、查证或执行，不要求用户理解或切换“讨论阶段/工程阶段”。
- 普通知识、进度询问和明确的“只讨论/先分析、不修改”只回答或做必要的只读查证，不因具有执行工具就修改、构建或启动。
- 用户要求制作、修复、继续既有任务或反馈上次修复仍未解决时，在已授权范围内检查现状并推进，不再索要同一份确认，不把返修送回方案确认循环。只有影响结果且无法从项目或对话确认的必要信息才追问。
- 继承用户仍有效的限制，以后来的明确变更为准。“只出 JAR、由我测试、不要启动”意味着继续修复和构建，但不启动客户端或服务器、不操作用户游戏；给出产物和手动验收步骤。功能已开放、skill 建议测试或旧方案要求测试，都不能覆盖用户的限制。
- 历史回答里的“本轮只读/下一轮工程阶段”只描述当时状态，不限制当前工作台请求。历史方案不等于用户已选择，构建成功不等于功能验收；如实说明已做、未做和受阻事项，不承诺不存在的后台监看。`

/** Beginner conversations always use the capable workspace runner, including
 * setup and option replies. The phase parameter only serves legacy workflows. */
export function isWorkbenchDiscussion(project: Pick<ProjectInfo, 'draft'>, phase?: 'discussion' | 'engineering', beginnerAgent = false): boolean {
  return !beginnerAgent && (Boolean(project.draft) || phase === 'discussion')
}

/** Keep project ownership and cancellation on the workspace while reusing the read-only inspiration runner. */
export function usesInspirationWorkflow(options: AiCreateCodeOptions): boolean {
  return options.surface === 'inspiration' || options.agentMode !== 'beginner' && options.workbenchPhase === 'discussion'
}

export function workbenchFlowOptions(discussion: boolean): Pick<AiCreateCodeOptions, 'surface' | 'workbenchPhase'> {
  return { surface: 'workspace', ...(discussion ? { workbenchPhase: 'discussion' as const } : {}) }
}

export function workbenchFlowBackend(mode: 'beginner' | 'advanced', configured: CodingBackend, engineeringHandoff: boolean): CodingBackend {
  return mode === 'beginner' || engineeringHandoff ? 'quota' : configured
}

export function discussionPrompt(request: string, context: string, project: Pick<ProjectInfo, 'name' | 'loader' | 'minecraftVersion' | 'draft'>, autoStartDraft = false): string {
  return `你正在灵感台的快速只读问答阶段。用简体中文直接回答，先理解需求和给出可执行的方案；仅在缺少影响结果的信息时追问，一次一个问题。不要写文件、安装、构建或运行测试，也不要声称已经完成制作。${autoStartDraft && project.draft ? '用户确认作品类型、版本和平台后，应用会自动创建工程并开始制作。补充信息选项应明确写出具体选择，不再要求额外点击开始制作。' : '用户通过对话里的制作选项明确交给工程阶段。'}\n${draftProjectContext(project, autoStartDraft)}\n${context ? `\n最近对话：\n${context}\n` : ''}\n用户最新请求：\n${request}\n\n${DISCUSSION_CHOICES_INSTRUCTION}`
}

export function engineeringHandoffPrompt(context: string, automatic = false): string {
  return `${automatic ? '用户已确认作品类型、版本和平台，应用已自动创建工程，现在开始制作。' : '用户已选择执行此请求，无需再次确认是否开始。'}请根据下面的完整对话实施用户认可的方案，继续使用当前项目，先检查已有实现。讨论中的建议不等于已完成的修改；不要把未选择的互斥方案全部实施。继承用户仍有效的限制，按最新要求完成修改和必要验证；如果用户要求只出 JAR、自己测试或不要启动，就只构建交付并给出手动验收步骤，不启动游戏或服务器。仍缺少无法从项目或对话中确认的必要信息时才追问。\n\n${context}`
}
