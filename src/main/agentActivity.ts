import type { AiActivity } from '../shared/aiActivity'

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const labels: Record<string, string> = {
  modmind_mcp_probe: '检查项目工具连接', modmind_project_info: '读取项目信息', modmind_project_files: '查看项目文件',
  modmind_read_project_file: '读取文件', modmind_read_document: '读取文档', modmind_project_search: '搜索项目',
  modmind_list_project_directory: '查看目录', modmind_apply_edits: '编辑文件', modmind_build_project: '构建项目',
  modmind_test_matrix: '运行项目测试', modmind_test_minecraft: '启动游戏验证', modmind_test_rendered: '运行客户端测试',
  modmind_test_session: '操作测试会话', modmind_test_capture: '截取游戏画面', modmind_test_scenario: '运行游戏测试步骤',
  modmind_test_observe: '检查游戏状态', modmind_test_action: '操作游戏', modmind_web_search: '搜索资料', modmind_web_read: '读取网页',
  modmind_image_generate: '生成图像', modmind_image_perfect_pixel: '处理像素图像', modmind_image_remove_background: '移除图像背景',
  modmind_modpack_build_server: '构建服务端包', modmind_modpack_apply_plan: '应用整合包方案',
  modmind_modpack_download_content: '下载项目内容', modmind_update_todo: '更新任务清单', modmind_research: '分析材料'
}

function filesFromItem(item: Record<string, any>): AiActivity['files'] {
  const args = record(item.arguments)
  const changes = Array.isArray(item.changes) ? item.changes : Array.isArray(args.edits) ? args.edits : []
  return changes.slice(0, 100).flatMap((change: unknown) => {
    const value = record(change)
    if (typeof value.path !== 'string') return []
    const kind = typeof value.kind === 'string' ? value.kind : record(value.kind).type
    const diff = typeof value.diff === 'string' ? value.diff.split('\n') : undefined
    const count = (text: unknown) => typeof text === 'string' && text ? text.replace(/\n$/, '').split('\n').length : 0
    return [{ path: value.path, operation: kind === 'add' || (!diff && !value.oldText && typeof value.newText === 'string') ? 'create' as const : kind === 'delete' ? 'delete' as const : 'edit' as const,
      ...(diff ? { added: diff.filter(line => line.startsWith('+') && !line.startsWith('+++')).length, removed: diff.filter(line => line.startsWith('-') && !line.startsWith('---')).length }
        : typeof value.newText === 'string' ? { added: count(value.newText), removed: count(value.oldText) } : {}) }]
  })
}

/** Adapts native lifecycle notifications; it never executes or replays an action. */
export class AgentActivityTracker {
  private items = new Map<string, AiActivity>()
  private lastOutput = new Map<string, number>()
  private taskIds = new Map<string, string>()
  private aliases = new Map<string, string>()
  constructor(private publish: (id: string, activity: AiActivity) => void, private now = () => new Date().toISOString()) {}

  item(value: unknown, completed = false): void {
    const item = record(value)
    if (typeof item.id !== 'string' || !['commandExecution', 'fileChange', 'webSearch', 'imageGeneration', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) return
    const args = record(item.arguments)
    let payload = record(item.result)
    for (const block of Array.isArray(payload.content) ? payload.content : []) {
      if (record(block).type === 'text') try { payload = { ...payload, ...record(JSON.parse(block.text)) } } catch { /* Non-JSON output is valid. */ }
    }
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : typeof args.taskId === 'string' ? args.taskId : undefined
    const id = this.aliases.get(item.id) ?? (taskId ? this.taskIds.get(taskId) : undefined) ?? item.id
    this.aliases.set(item.id, id)
    if (this.aliases.size > 1024) this.aliases.delete(this.aliases.keys().next().value!)
    if (taskId) this.taskIds.set(taskId, id)
    const previous = this.items.get(id)
    const tool = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : ''
    const name = tool.replace(/^mcp__modmind__/, '')
    const kind: AiActivity['kind'] | undefined = item.type === 'commandExecution' ? 'command' : item.type === 'fileChange' ? 'file'
      : item.type === 'webSearch' ? 'search' : item.type === 'imageGeneration' ? 'tool'
      : ['mcpToolCall', 'dynamicToolCall'].includes(item.type) ? /build/.test(name) ? 'build' : /test_|server_/.test(name) ? 'test' : /apply_edits/.test(name) ? 'file' : 'tool' : undefined
    if (!kind) return
    const files = filesFromItem(item)
    const failed = ['failed', 'declined'].includes(item.status) || payload.status === 'failed' || item.error != null || item.success === false || payload.isError === true || payload.success === false || typeof item.exitCode === 'number' && item.exitCode !== 0
    const textError = failed && Array.isArray(record(item.result).content)
      ? item.result.content.filter((block: unknown) => record(block).type === 'text' && typeof record(block).text === 'string').map((block: { text: string }) => block.text).join('\n').slice(0, 1000) : ''
    const backgroundRunning = completed && ['running', 'cancelling'].includes(payload.status)
    const activity: AiActivity = { ...previous, kind, title: previous?.title ?? (kind === 'command' ? '运行命令' : kind === 'file' ? '编辑文件' : item.type === 'webSearch' ? '搜索资料' : item.type === 'imageGeneration' ? '生成图像' : labels[name] ?? `调用 ${tool || '工具'}`),
      status: backgroundRunning ? 'running' : completed ? item.status === 'cancelled' || payload.status === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'completed' : 'running',
      startedAt: previous?.startedAt ?? this.now(), ...(completed && !backgroundRunning ? { completedAt: this.now() } : {}),
      ...(tool ? { tool: name } : {}), ...(typeof item.command === 'string' ? { command: item.command.slice(0, 4000) } : {}),
      ...(typeof args.path === 'string' ? { detail: args.path.slice(0, 500) } : {}),
      ...(files?.length ? { files } : {}),
      ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput.slice(-12000) } : {}),
      ...(typeof record(payload.state).message === 'string' ? { detail: payload.state.message.slice(-1000) } : {}),
      ...(failed && (item.error || payload.error || textError) ? { detail: String(record(item.error ?? payload.error).message ?? item.error ?? payload.error ?? textError).slice(0, 1000) } : {}) }
    if (previous?.status !== 'running' && previous?.completedAt && !completed) return
    if (this.items.size >= 512 && !previous) {
      const oldest = [...this.items].find(([, value]) => value.status !== 'running')
      if (oldest) {
        this.items.delete(oldest[0]); this.lastOutput.delete(oldest[0])
        for (const [task, owner] of this.taskIds) if (owner === oldest[0]) this.taskIds.delete(task)
      }
    }
    this.items.set(id, activity)
    this.publish(id, activity)
  }

  output(id: unknown, delta: unknown, progress = false): void {
    if (typeof id !== 'string' || typeof delta !== 'string') return
    const canonical = this.aliases.get(id) ?? id
    const item = this.items.get(canonical)
    if (!item || item.status !== 'running') return
    const updated = { ...item, output: `${item.output ?? ''}${delta}`.slice(-12000), ...(progress ? { detail: delta.trim().slice(-1000) } : {}) }
    this.items.set(canonical, updated)
    if (Date.now() - (this.lastOutput.get(canonical) ?? 0) >= 180) {
      this.lastOutput.set(canonical, Date.now())
      this.publish(canonical, updated)
    }
  }

  approval(id: string, completed: boolean, failed = false, detail?: string): void {
    const previous = this.items.get(id)
    const activity: AiActivity = { kind: 'approval', title: '检查操作权限', startedAt: previous?.startedAt ?? this.now(), status: completed ? failed ? 'failed' : 'completed' : 'running', ...(completed ? { completedAt: this.now() } : {}), ...(detail ? { detail: detail.slice(0, 1000) } : {}) }
    this.items.set(id, activity)
    this.publish(id, activity)
  }
}
