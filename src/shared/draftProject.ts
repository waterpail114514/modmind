import type { ProjectCreateInput, ProjectInfo } from './types'

/** Record only an unambiguous user selection, never an assistant suggestion or a question. */
export function draftTargetFromMessage(previous: Partial<ProjectCreateInput>, message: string): Partial<ProjectCreateInput> {
  const next = { ...previous }
  const text = message.trim()
  if (/[?？]|还是|或者|推荐|不确定|不知道|不要|不用|不是|不想/.test(text)) return next
  const versions = [...new Set(text.match(/\b(?:1|26|3)\.\d{1,3}(?:\.\d{1,3})?(?:-SNAPSHOT)?\b(?!\.)/g) ?? [])]
  if (versions.length === 1) next.minecraftVersion = versions[0]
  const loaders = [...new Set((text.match(/\b(?:neoforge|forge|fabric|quilt|bedrock|paper|spigot|folia|velocity)\b/gi) ?? []).map(value => value.toLowerCase()))]
  if (/基岩/.test(text)) loaders.push('bedrock')
  if (/网易/.test(text) && /手机|移动/.test(text)) loaders.push('netease-mobile')
  if (/网易/.test(text) && /电脑|PC/i.test(text)) loaders.push('netease-pc')
  if (new Set(loaders).size === 1) next.loader = loaders[0] as ProjectCreateInput['loader']
  if (/服务端插件|服务器插件|\b(?:paper|spigot|folia|velocity)\b/i.test(text)) next.kind = 'server-plugin'
  else if (/整合包|\bmodpack\b/i.test(text)) next.kind = 'modpack'
  else if (/模组|\bmod\b|附加包|行为包|资源包/i.test(text)) next.kind = 'mod'
  return next
}

export function missingDraftDetails(project: Pick<ProjectInfo, 'draft'>): string[] {
  if (!project.draft) return []
  const target = project.draft.target
  return [!target.kind && '作品类型（模组、整合包或服务端插件）', !target.minecraftVersion && 'Minecraft 或代理 API 版本', !target.loader && '加载器或游戏平台'].filter((value): value is string => Boolean(value))
}

export function draftProjectContext(project: Pick<ProjectInfo, 'name' | 'loader' | 'minecraftVersion' | 'draft'>): string {
  if (!project.draft) return `当前项目：${project.name}；Minecraft ${project.minecraftVersion}；加载器 ${project.loader}。不要重复询问已有的项目版本或加载器。`
  const target = project.draft.target
  return `当前是仅保存对话的空壳项目，还没有源码、构建文件或已选定的默认版本。项目标识里的占位 loader 不是用户选择，不能据此推断平台。\n用户已明确的信息：类型 ${target.kind ?? '未确认'}；Minecraft ${target.minecraftVersion ?? '未确认'}；平台 ${target.loader ?? '未确认'}。\n尚缺：${missingDraftDetails(project).join('、') || '无，用户可点击开始制作生成工程'}。缺少时在回答中自然追问一次一个问题；请用户明确说出具体版本和平台名称。可以推荐但不能把建议当作用户的选择。不要要求用户新建目录或填写项目表单，也不要尝试生成工程。`
}
