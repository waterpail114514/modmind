import type { AgentSettings, LoaderKind, ProjectKind, ReasoningEffort, RemoteConnectionState } from '../shared/types'

export interface RemoteQuotaConfig {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort?: ReasoningEffort
}

export interface RemoteProjectSummary {
  id: string
  name: string
  kind: string
  loader: string
  minecraftVersion: string
}

export interface RemoteAppState {
  currentProject: RemoteProjectSummary | null
  projects: RemoteProjectSummary[]
  agent: AgentSettings['codingBackend']
  model?: string
  remote: RemoteConnectionState
}

export type RemoteAppAction =
  | { type: 'create_project'; name: string; loader: LoaderKind; minecraftVersion: string; kind?: ProjectKind }
  | { type: 'select_project'; projectId: string }
  | { type: 'open_page'; page: string }
  | { type: 'open_window'; view: string; title?: string }
  | { type: 'close_window'; view?: string }
  | { type: 'open_settings' }
  | { type: 'open_project_folder' }
  | { type: 'open_ide' }
  | { type: 'minimize' }
  | { type: 'close_app' }
  | { type: 'set_workbench_agent'; agent: AgentSettings['codingBackend'] }
  | { type: 'set_workbench_model'; model: string }
  | { type: 'set_app_setting'; key: 'darkMode' | 'closeBehavior' | 'notificationsEnabled' | 'allowBuildScriptChanges' | 'preferLocalGradle' | 'gradleDownloadSource' | 'javaPreferences'; value: boolean | string | Record<string, unknown> }
  | { type: 'get_app_settings' }
  | { type: 'scan_java_homes' }
  | { type: 'probe_java_home'; home: string }
  /** AI-initiated export of decompiled sources into a self-made module. Requires explicit terms acknowledgement fields. */
  | {
    type: 'decompile_jar_to_module'
    jarPath: string
    moduleName: string
    /** Must quote the current DECOMPILE_TERMS_VERSION verbatim — proves the model surfaced the terms. */
    termsVersionAcknowledged: string
    minecraftVersion?: string
    skipRemap?: boolean
  }

export interface RemoteAppControlHost {
  getState: () => Promise<RemoteAppState>
  execute: (action: RemoteAppAction) => Promise<unknown>
}

export interface RemoteControllerCallbacks {
  onActivity?: (text: string, progress?: number) => void
  signal?: AbortSignal
}

export interface RemoteControllerResult {
  status: 'COMPLETED' | 'FAILED'
  text?: string
  error?: string
  result?: Record<string, unknown>
}

export interface RemoteControllerWorkbench {
  run: (prompt: string, callbacks: RemoteControllerCallbacks) => Promise<{
    summary: string
    result?: Record<string, unknown>
    changedFiles?: string[]
  }>
}

type DecisionKind = 'WORKBENCH' | 'APP_CONTROL' | 'MIXED' | 'UNSUPPORTED'

interface ControllerDecision {
  kind: DecisionKind
  actions?: unknown
  workbenchPrompt?: unknown
  reply?: unknown
}

function trimTerminalChinesePeriod(value: string): string {
  return value.replace(/。(?=\s*$)/u, '')
}

export const REMOTE_WORKBENCH_CAPABILITIES = [
  '项目源码、资源、配置和文档的创建或修改',
  '依赖、映射、内容校验和发布准备',
  '本地或托管 Gradle 构建、测试矩阵和 Minecraft 测试',
  'Blockbench、图片资源、整合包和服务端包操作',
  '任何最终目的是改变、验证、构建或测试当前项目的请求'
]

export const REMOTE_APP_CONTROL_CAPABILITIES = [
  '新建 ModMind 项目或整合包（创建时由桌面端选择目标父目录）',
  '切换当前项目、打开项目目录、打开 IDE、打开页面、打开或关闭独立窗口',
  '在整合包项目中把反编译过的 JAR 源码导出为自制模组模块（必须携带用户已确认的当前条款版本号）',
  '读取或修改 ModMind 应用设置',
  '切换工作台使用的 Agent 或模型',
  '最小化、关闭应用和显示工作台状态'
]

export const REMOTE_APP_PAGES = [
  'workspace', 'sounds', 'modpack-content', 'ftb-quests', 'patchouli', 'modpack-automation', 'modpack-server',
  'modpack-mod-list', 'third-party-mods', 'modpack-manifest', 'modpack-config', 'modpack-scripts',
  'modpack-datapacks', 'modpack-resourcepacks', 'modpack-shaders', 'modpack-ui', 'modpack-worlds',
  'modpack-client', 'modpack-server-content', 'modpack-files', 'inspiration', 'image-studio',
  'blockbench', 'minecraft', 'mappings', 'code', 'build', 'snapshots', 'production', 'settings'
] as const

const ALLOWED_PAGES = new Set<string>(REMOTE_APP_PAGES)

const ALLOWED_AGENTS = new Set<AgentSettings['codingBackend']>(['quota', 'codex', 'claude'])

const WORKBENCH_DIAGNOSTIC_PATTERN = /(诊断|排查|检查.*(?:哪里|哪儿|问题|错误|坏)|看看.*(?:问题|错误|坏)|哪里(?:坏|有问题)|查一下.*(?:问题|错误)|测试.*失败)/i
const CONTINUATION_MARKER_PATTERN = /(然后|接着|继续|再试|再做|并且|并继续|做完|完成)/i
const WORKBENCH_TASK_PATTERN = /(工作台|源码|代码|功能|构建|测试|添加|修改|修复|实现|开发|发个|发送)/i
const DESTRUCTIVE_PATTERN = /(删除|删掉|清掉|清除|移除|覆盖|重置|清空|抹掉)/i
const VAGUE_TARGET_PATTERN = /(之前|以前|没用的|不用的|相关的|那些|这些|这个|那个|东西|全部|都|它|一切|无用)/i
const EXPLICIT_TARGET_PATTERN = /(?:[a-z0-9_.-]+[\\/][a-z0-9_.-]+|[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|java|kt|png|jpg|jar|mcmeta|md)|(?:项目|文件|目录|文件夹|模块|依赖|配置)\s*[“"']?[^，。！？\s“"']+)/i

function isWorkbenchDiagnosticRequest(prompt: string): boolean {
  return WORKBENCH_DIAGNOSTIC_PATTERN.test(prompt)
}

function hasWorkbenchContinuationIntent(prompt: string): boolean {
  if (/(接着|继续|再试|再做|完成)/i.test(prompt)) return true
  return CONTINUATION_MARKER_PATTERN.test(prompt) && WORKBENCH_TASK_PATTERN.test(prompt)
}

function ambiguousDestructiveRequest(prompt: string): boolean {
  return DESTRUCTIVE_PATTERN.test(prompt) && VAGUE_TARGET_PATTERN.test(prompt) && !EXPLICIT_TARGET_PATTERN.test(prompt)
}

function clarificationForLocalGuard(prompt: string): string | null {
  if (/(?:窗口.*(?:收起|收起来|藏起来)|收起(?:来)?窗口)/i.test(prompt)) {
    return '请说明要关闭独立窗口，还是最小化 ModMind 主窗口'
  }
  if (ambiguousDestructiveRequest(prompt)) {
    return '这个请求涉及删除、清理或覆盖，但目标不明确。请说明具体项目、文件或目录'
  }
  return null
}

const REMOTE_APP_ACTION_CATALOG = [
  '{"type":"create_project","name":"<project name>","loader":"fabric|quilt|forge|neoforge|bedrock|netease-pc|netease-mobile","minecraftVersion":"<version>","kind":"mod|modpack"}',
  '{"type":"select_project","projectId":"<id from appState.projects>"}',
  '{"type":"open_page","page":"<supported page id>"}',
  '{"type":"open_window","view":"<supported page id>","title":"<optional title>"}',
  '{"type":"close_window","view":"<optional supported page id; omit to close detached windows>"}',
  '{"type":"open_settings"}',
  '{"type":"open_project_folder"}',
  '{"type":"open_ide"}',
  '{"type":"minimize"}',
  '{"type":"close_app"}',
  '{"type":"set_workbench_agent","agent":"quota|codex|claude"}',
  '{"type":"set_workbench_model","model":"<model id>"}',
  '{"type":"set_app_setting","key":"darkMode|notificationsEnabled|allowBuildScriptChanges|preferLocalGradle","value":true|false}',
  '{"type":"set_app_setting","key":"closeBehavior","value":"ask|tray|quit"}',
  '{"type":"set_app_setting","key":"gradleDownloadSource","value":"auto|china|official"}',
  '{"type":"set_app_setting","key":"javaPreferences","value":{"game":"<java home>","build":"<java home>","tools":"<java home>"}}',
  '{"type":"get_app_settings"}',
  '{"type":"scan_java_homes"}',
  '{"type":"probe_java_home","home":"<java home or bin/java path>"}'
] as const

// Keep the prompt assembly readable while exposing the catalog for tests and future UI surfaces.
const WORKBENCH_CAPABILITIES = REMOTE_WORKBENCH_CAPABILITIES
const CONTROL_CAPABILITIES = REMOTE_APP_CONTROL_CAPABILITIES

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Remote Controller 任务已取消'), { name: 'AbortError' })
}

function extractJson(content: string): ControllerDecision {
  const source = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidate = source.match(/\{[\s\S]*\}/)?.[0] ?? source
  const value = JSON.parse(candidate) as ControllerDecision
  if (!value || typeof value !== 'object') throw new Error('Remote Controller 返回格式无效')
  if (!['WORKBENCH', 'APP_CONTROL', 'MIXED', 'UNSUPPORTED'].includes(value.kind)) throw new Error('Remote Controller 未返回有效路由')
  return value
}

function messageContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const body = payload as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string').map((part) => String((part as { text: string }).text)).join('\n')
  return ''
}

function appAction(value: unknown, index: number): RemoteAppAction {
  if (!value || typeof value !== 'object') throw new Error(`Remote Controller 应用操作 ${index + 1} 格式无效`)
  const item = value as Record<string, unknown>
  const type = String(item.type ?? '')
  switch (type) {
    case 'create_project': {
      const name = String(item.name ?? '').trim().slice(0, 120)
      const loader = String(item.loader ?? '') as LoaderKind
      const minecraftVersion = String(item.minecraftVersion ?? '').trim().slice(0, 80)
      const kind = item.kind === 'modpack' ? 'modpack' : 'mod'
      if (!name) throw new Error('新建项目缺少项目名称')
      if (!['fabric', 'quilt', 'forge', 'neoforge', 'bedrock', 'netease-pc', 'netease-mobile'].includes(loader)) throw new Error(`不支持的新建项目平台：${loader}`)
      if (!minecraftVersion) throw new Error('新建项目缺少 Minecraft 版本')
      return { type, name, loader, minecraftVersion, kind }
    }
    case 'select_project': {
      const projectId = String(item.projectId ?? '').trim()
      if (!projectId) throw new Error('切换项目缺少 projectId')
      return { type, projectId }
    }
    case 'open_page': {
      const page = String(item.page ?? '')
      if (!ALLOWED_PAGES.has(page)) throw new Error(`不支持打开页面：${page}`)
      return { type, page }
    }
    case 'open_window': {
      const view = String(item.view ?? '')
      if (!ALLOWED_PAGES.has(view)) throw new Error(`不支持打开独立窗口：${view}`)
      return { type, view, ...(typeof item.title === 'string' ? { title: item.title.slice(0, 120) } : {}) }
    }
    case 'close_window': {
      const view = typeof item.view === 'string' && item.view ? item.view : undefined
      if (view && !ALLOWED_PAGES.has(view)) throw new Error(`不支持关闭窗口：${view}`)
      return { type, ...(view ? { view } : {}) }
    }
    case 'open_settings': return { type }
    case 'open_project_folder': return { type }
    case 'open_ide': return { type }
    case 'minimize': return { type }
    case 'close_app': return { type }
    case 'set_workbench_agent': {
      const agent = String(item.agent ?? '') as AgentSettings['codingBackend']
      if (!ALLOWED_AGENTS.has(agent)) throw new Error(`不支持的工作台 Agent：${agent}`)
      return { type, agent }
    }
    case 'set_workbench_model': {
      const model = String(item.model ?? '').trim().slice(0, 256)
      if (!model) throw new Error('工作台模型不能为空')
      return { type, model }
    }
    case 'set_app_setting': {
      const key = String(item.key) as 'darkMode' | 'closeBehavior' | 'notificationsEnabled' | 'allowBuildScriptChanges' | 'preferLocalGradle' | 'gradleDownloadSource' | 'javaPreferences'
      if (!['darkMode', 'closeBehavior', 'notificationsEnabled', 'allowBuildScriptChanges', 'preferLocalGradle', 'gradleDownloadSource', 'javaPreferences'].includes(key)) throw new Error(`不支持的应用设置：${key}`)
      if (key === 'javaPreferences') {
        if (typeof item.value !== 'object' || item.value === null || Array.isArray(item.value)) throw new Error('Java 偏好需要对象值')
      } else if (typeof item.value !== 'boolean' && typeof item.value !== 'string') throw new Error(`应用设置 ${key} 的值无效`)
      const value = typeof item.value === 'object' ? item.value as Record<string, unknown> : item.value
      return { type, key, value }
    }
    case 'get_app_settings': return { type }
    case 'scan_java_homes': return { type }
    case 'probe_java_home': {
      const home = String(item.home ?? '').trim().slice(0, 4096)
      if (!home) throw new Error('探测 Java 路径不能为空')
      return { type, home }
    }
    case 'decompile_jar_to_module': {
      const jarPath = String(item.jarPath ?? '').trim()
      const moduleName = String(item.moduleName ?? '').trim().slice(0, 120)
      // The acknowledgement string must be present; the executor verifies it matches the
      // CURRENT terms version, so a stale or invented version is rejected at execution time.
      const termsVersionAcknowledged = String(item.termsVersionAcknowledged ?? '').trim()
      if (!jarPath) throw new Error('反编译导出缺少 JAR 路径')
      if (!moduleName) throw new Error('反编译导出缺少模块名称')
      if (!termsVersionAcknowledged) throw new Error('反编译导出必须携带用户已确认的条款版本（termsVersionAcknowledged）')
      return {
        type,
        jarPath,
        moduleName,
        termsVersionAcknowledged,
        ...(typeof item.minecraftVersion === 'string' && item.minecraftVersion.trim() ? { minecraftVersion: item.minecraftVersion.trim().slice(0, 80) } : {}),
        skipRemap: item.skipRemap === true
      }
    }
    default: throw new Error(`不支持的 Remote Controller 操作：${type}`)
  }
}

export class RemoteControllerAgent {
  constructor(
    private readonly getQuotaConfig: () => Promise<RemoteQuotaConfig>,
    private readonly app: RemoteAppControlHost,
    private readonly workbench: RemoteControllerWorkbench
  ) {}

  async handle(text: string, callbacks: RemoteControllerCallbacks = {}): Promise<RemoteControllerResult> {
    const prompt = text.trim()
    if (!prompt) return { status: 'FAILED', error: 'Remote 请求内容为空' }
    abortIfNeeded(callbacks.signal)
    const localGuard = clarificationForLocalGuard(prompt)
    if (localGuard) return { status: 'COMPLETED', text: localGuard }
    const state = await this.app.getState()
    callbacks.onActivity?.('Remote Agent 正在判断请求属于工作台任务还是 ModMind 操作', 0.1)
    const config = await this.getQuotaConfig()
    const requestController = new AbortController()
    const timeout = setTimeout(() => requestController.abort(), 45_000)
    const forwardAbort = (): void => requestController.abort()
    callbacks.signal?.addEventListener('abort', forwardAbort, { once: true })
    let response: Response
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          reasoning_effort: config.reasoningEffort,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: `你是 ModMind Remote Controller。你只负责判断请求路由和控制 ModMind 应用，不负责修改项目文件。\n\n严格规则：\n1. 只要请求涉及项目源码、资源、配置、依赖、构建、测试、Minecraft、Blockbench、图片资源或整合包，就归类 WORKBENCH。手动点击构建和 MCP 构建属于同一个 WORKBENCH 能力。\n2. WORKBENCH 请求不要改写用户原话。桌面端会把原始请求原样交给工作台。\n3. APP_CONTROL 只能用于 ModMind 应用层操作。\n4. MIXED 用于同时包含应用控制和项目任务；先给出应用操作，再给出交给工作台的子任务。\n5. 无法完成时使用 UNSUPPORTED，不要编造已执行。\n6. 只返回 JSON，不要 Markdown。\n\nWORKBENCH 能力：\n${WORKBENCH_CAPABILITIES.map((item) => `- ${item}`).join('\n')}\n\nAPP_CONTROL 能力：\n${CONTROL_CAPABILITIES.map((item) => `- ${item}`).join('\n')}\n\nJSON 格式：\nWORKBENCH: {"kind":"WORKBENCH"}\nAPP_CONTROL: {"kind":"APP_CONTROL","actions":[{"type":"..."}],"reply":"..."}\nMIXED: {"kind":"MIXED","actions":[{"type":"..."}],"workbenchPrompt":"交给工作台的任务"}\nUNSUPPORTED: {"kind":"UNSUPPORTED","reply":"..."}`
             },
            {
              role: 'system',
              content: `APP_CONTROL actions are limited to these exact JSON objects. Never invent an action type. Creating/opening/switching a project is APP_CONTROL, not WORKBENCH. For a request like "create a project and then do X", return MIXED with create_project first. If project details are omitted, use name "新项目", loader "fabric", Minecraft version "1.21.1", kind "mod". Page/view values must be one of: ${REMOTE_APP_PAGES.join(', ')}\n${REMOTE_APP_ACTION_CATALOG.map((item) => `- ${item}`).join('\n')}`
            },
            { role: 'user', content: JSON.stringify({ request: prompt, appState: state }) }
          ]
        }),
        signal: requestController.signal
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(`Remote Controller 请求失败（HTTP ${response.status}）`)
      const decision = extractJson(messageContent(payload))
      abortIfNeeded(callbacks.signal)

      // A diagnostic request is a project task even if the controller model
      // mistakenly labels it as an app operation or unsupported request.
      if ((decision.kind === 'APP_CONTROL' || decision.kind === 'UNSUPPORTED') && isWorkbenchDiagnosticRequest(prompt)) {
        if (!state.currentProject) return { status: 'COMPLETED', text: '当前还没有打开项目，请先打开一个项目' }
        await this.app.execute({ type: 'open_page', page: 'workspace' })
        abortIfNeeded(callbacks.signal)
        callbacks.onActivity?.('已识别为项目诊断请求，正在原样转交工作台', 0.2)
        const result = await this.workbench.run(text, callbacks)
        return { status: 'COMPLETED', text: trimTerminalChinesePeriod(result.summary), result: { ...(result.result ?? {}), changedFiles: result.changedFiles ?? [] } }
      }

      if (decision.kind === 'MIXED') {
        if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
          return { status: 'COMPLETED', text: '混合请求缺少明确的 ModMind 应用操作，请重新说明要切换或执行的应用动作' }
        }
        if (typeof decision.workbenchPrompt !== 'string' || !decision.workbenchPrompt.trim()) {
          return { status: 'COMPLETED', text: '混合请求缺少明确的工作台任务，请说明应用操作完成后要继续做什么' }
        }
      }

      if (decision.kind === 'WORKBENCH') {
        if (!state.currentProject) return { status: 'COMPLETED', text: '当前还没有打开项目，请先打开一个项目' }
        await this.app.execute({ type: 'open_page', page: 'workspace' })
        abortIfNeeded(callbacks.signal)
        callbacks.onActivity?.('已识别为项目开发请求，正在原样转交工作台', 0.2)
        const result = await this.workbench.run(text, callbacks)
        return { status: 'COMPLETED', text: trimTerminalChinesePeriod(result.summary), result: { ...(result.result ?? {}), changedFiles: result.changedFiles ?? [] } }
      }

      if (decision.kind === 'UNSUPPORTED') {
        return { status: 'COMPLETED', text: typeof decision.reply === 'string' && decision.reply.trim() ? trimTerminalChinesePeriod(decision.reply.trim()) : '这个请求不在当前 Remote Agent 的能力范围内' }
      }

      const rawActions = Array.isArray(decision.actions) ? decision.actions : []
      if (rawActions.length > 32) throw new Error('Remote Controller 单次应用操作过多')

      // Multiple explicit app actions are valid and run in order. Only block
      // an app-only decision when it contains an unspecified continuation
      // task, such as "切到另一个，然后接着做".
      if (decision.kind === 'APP_CONTROL' && hasWorkbenchContinuationIntent(prompt) && (rawActions.length < 2 || /(接着|继续|再试|再做|完成)/i.test(prompt))) {
        return { status: 'COMPLETED', text: '你要求切换或调整后继续执行，但没有说明要继续做什么；请补充具体的项目任务' }
      }

      const actions = rawActions.map(appAction)
      const actionResults: unknown[] = []
      for (const [index, action] of actions.entries()) {
        abortIfNeeded(callbacks.signal)
        callbacks.onActivity?.(`正在执行 ModMind 应用操作 ${index + 1}/${actions.length}`, 0.25 + (index / Math.max(actions.length, 1)) * 0.35)
        actionResults.push(await this.app.execute(action))
        abortIfNeeded(callbacks.signal)
      }

      if (decision.kind === 'APP_CONTROL') {
        return { status: 'COMPLETED', text: typeof decision.reply === 'string' && decision.reply.trim() ? trimTerminalChinesePeriod(decision.reply.trim()) : '已完成 ModMind 应用操作', result: { actions: actionResults } }
      }

      const workbenchPrompt = typeof decision.workbenchPrompt === 'string' ? trimTerminalChinesePeriod(decision.workbenchPrompt.trim()) : ''
      const stateAfterActions = await this.app.getState()
      if (!stateAfterActions.currentProject) return { status: 'COMPLETED', text: '应用操作已完成，但当前还没有打开项目，暂时不能执行项目任务', result: { actions: actionResults } }
      await this.app.execute({ type: 'open_page', page: 'workspace' })
      abortIfNeeded(callbacks.signal)
      callbacks.onActivity?.('应用操作已完成，正在把项目任务交给工作台', 0.65)
      const result = await this.workbench.run(workbenchPrompt, callbacks)
      return {
        status: 'COMPLETED',
        text: trimTerminalChinesePeriod(result.summary),
        result: { actions: actionResults, workbench: result.result ?? {}, changedFiles: result.changedFiles ?? [] }
      }
    } finally {
      clearTimeout(timeout)
      callbacks.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
