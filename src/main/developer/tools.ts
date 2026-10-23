import Ajv from 'ajv'
import type { ExternalAgentBridgeHandlers } from '../externalAgents'
import type { FeaturePluginDiscoveredTool, FeaturePluginDefinition } from '../../shared/featurePlugins'
import type { DeveloperService } from './service'
import type { DeveloperDebugInput } from '../../shared/developerWorkbench'

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required })
const string = { type: 'string', minLength: 1, maxLength: 240 }
const definitions: FeaturePluginDiscoveredTool[] = [
  { pluginId: 'developer', name: 'modmind_dev_read', action: 'read', description: 'Read the active independent extension workspace: info, file list, source/SDK/reference text. Read returns a revision required for writes.', permission: 'read', projectRequired: true,
    inputSchema: object({ operation: { enum: ['info', 'files', 'read', 'test-read'] }, path: string, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 65536 } }, ['operation']) },
  { pluginId: 'developer', name: 'modmind_dev_write', action: 'write', description: 'Create or update one source file in this development workspace using its expected revision (null only for new files). SDK and reference files are read-only.', permission: 'write', projectRequired: true,
    inputSchema: object({ path: string, content: { type: 'string', maxLength: 4 * 1024 * 1024 }, revision: { type: ['string', 'null'] } }, ['path', 'content', 'revision']) },
  { pluginId: 'developer', name: 'modmind_dev_build', action: 'build', description: 'Build an immutable snapshot: type-check and compile source projects, or syntax-check and repackage imported JavaScript. Validate the extension contract and return the portable mmfeature/mmstudio build identity and source revision.', permission: 'process', projectRequired: true, inputSchema: object({}, []) },
  { pluginId: 'developer', name: 'modmind_dev_debug', action: 'debug', description: 'Run the compiled package in an independent local test host: inspect, invoke an action, invoke a declared MCP tool, or create a studio test project and return files/AI profiles. Native code has local Node permissions. Requires a current build.', permission: 'process', projectRequired: true,
    inputSchema: object({ operation: { enum: ['inspect', 'action', 'tool', 'create-studio'] }, name: string, input: { type: 'object' }, readOnly: { type: 'boolean' } }, ['operation']) },
  { pluginId: 'developer', name: 'modmind_dev_preview', action: 'preview', description: 'Capture the current compiled UI preview as an image for visual inspection. Uses sample project data and the selected package page. Does not prove action or target-host compatibility.', permission: 'process', projectRequired: true,
    inputSchema: object({ page: string, dark: { type: 'boolean' } }, []) },
  { pluginId: 'developer', name: 'modmind_dev_export', action: 'export', description: 'Return the verified local archive from the current build, ready for export or local installation. Does not install or publish the package.', permission: 'read', projectRequired: true, inputSchema: object({}, []) }
]
const ajv = new Ajv({ strictTypes: false, allowUnionTypes: true })
const checks = new Map(definitions.map(tool => [tool.action, ajv.compile(tool.inputSchema)]))

export function developerBridge(service: DeveloperService, session: string, capture: (page?: string, dark?: boolean) => Promise<unknown>): ExternalAgentBridgeHandlers {
  const project = service.assert(session)
  const context = `你正在 ModMind 开发者工作台中开发 ${project.kind === 'studio' ? '.mmstudio 自定义工作台' : '.mmfeature 功能包'}：${project.name}。工程根目录：${project.root}。
这是独立扩展工程。使用内置 @modmind/sdk；先读取 manifest.json、sdk/index.d.ts 和相关源码。reference/ 中包含与当前应用匹配的开发指南；这些指南中的仓库构建命令在本环境由 modmind_dev_build 替代，源码导入统一用 @modmind/sdk。禁止导入 ModMind 源码内部模块或假设存在未公开宿主 API。
通过专用开发工具读取、修改、构建、预览和调试。${project.sourceMode === 'package' ? '当前工程从发布包导入，业务入口是 main.cjs，页面是 renderer.js，样式是 renderer.css；直接编辑包内 JavaScript 和配置，不要假设存在原始 TypeScript/TSX。构建会校验 JavaScript 语法与包契约、保留资源并重新生成校验和。现有包在独立 Electron 兼容宿主中运行，复用真实 preload API、声明动作和已安装依赖；不要给缺少的游戏数据或凭据伪造成功结果。' : '业务动作由 main.ts 提供，UI 和 MCP 调用同一动作。'}不要为预览伪造功能成功；未实现的能力应明确返回不可用。第一版支持 React/TSX/CSS、静态资源、本包 actions/tools、templateFiles 和 AI profile；新建源码工程不开放任意 npm 包、异步 scaffold 和接管。导入包支持设置页及其声明的现有宿主动作；未开放的全局应用操作需明确返回不可用。
修改文件必须先读取 revision，保留用户草稿；sdk/、reference/、modmind.dev.json 由应用管理。每次实际修改后调用 modmind_dev_build；用 modmind_dev_preview 查看画面，用 modmind_dev_debug 验证动作或 MCP。自定义工作台还要用 create-studio 验证模板、元数据和两份 AI profile。导出前回读产物。工具返回的状态仅证明其描述的验证范围。响应使用简体中文。`
  const unavailable = async (): Promise<never> => { throw new Error('独立开发工作区未开放普通项目工具') }
  const manifest: FeaturePluginDefinition = { format: 'modmind-feature', apiVersion: 2, hostVersion: '1.5.0-plugintest', id: 'developer', name: '开发工具', version: '1.0.0', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', actions: definitions.map(tool => ({ id: tool.action, handler: tool.action, permission: tool.permission, inputSchema: tool.inputSchema })), tools: definitions }
  return {
    workspaceContext: context,
    get projectInfo() { const active = service.assert(session); return { name: active.name, path: active.root, kind: 'developer', packageType: active.kind, id: active.id } },
    imageStudioAvailable: () => false,
    featureCatalog: async () => { service.assert(session); return [{ id: 'developer', name: '开发工具', version: '1.0.0', installed: true, enabled: true, available: true, state: 'ready', installHint: '', manifest }] },
    featureTools: async () => { service.assert(session); return definitions },
    featureInvoke: async (id, action, input, invocation) => {
      const active = service.assert(session)
      const tool = definitions.find(item => item.action === action)
      if (id !== 'developer' || !tool || invocation.projectPath !== active.root) throw new Error('开发工具作用范围无效')
      if (invocation.readOnly && tool.permission !== 'read') throw new Error('只读会话禁止修改、预览或执行开发工程')
      const check = checks.get(action)!
      if (!check(input)) throw new Error('开发工具参数无效：' + ajv.errorsText(check.errors))
      switch (action) {
        case 'read':
          if (input.operation === 'info') return service.state(session)
          if (input.operation === 'files') return { files: await service.files(session) }
          if (typeof input.path !== 'string') throw new Error('read 需要文件路径')
          {
            const text = await (input.operation === 'test-read' ? service.readTest(session, input.path) : service.read(session, input.path))
            const offset = Number(input.offset ?? 0), length = Number(input.length ?? 65536)
            return { ...text, content: text.content.slice(offset, offset + length), offset, nextOffset: offset + length < text.content.length ? offset + length : null, totalCharacters: text.content.length }
          }
        case 'write': return service.write(session, input.path as string, input.content as string, input.revision as string | null)
        case 'build': return service.build(session)
        case 'debug': return service.debug(session, input as unknown as DeveloperDebugInput)
        case 'preview': return capture(input.page as string | undefined, input.dark as boolean | undefined)
        case 'export': {
          const artifact = await service.artifact(session)
          return { status: 'completed', verified: true, path: artifact.file, buildId: artifact.build.id, bytes: artifact.build.bytes }
        }
      }
      throw new Error('未知开发动作')
    },
    setIntent: unavailable, applyEdits: unavailable, updateTodo: unavailable,
    testMatrix: unavailable, build: unavailable, testMinecraft: unavailable, runtimeState: unavailable
  }
}
