vi.mock('./networkRequest', async (importOriginal) => ({ ...(await importOriginal<typeof import('./networkRequest')>()), networkFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init) }))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteControllerAgent, type RemoteAppControlHost, type RemoteAppState } from './remoteAgentController'

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const state: RemoteAppState = {
  currentProject: { id: 'project-1', name: 'Demo', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1' },
  projects: [{ id: 'project-1', name: 'Demo', kind: 'mod', loader: 'fabric', minecraftVersion: '1.21.1' }],
  agent: 'codex',
  model: 'gpt-5.6-sol',
  remote: { status: 'ready', enabled: true }
}

function host(overrides: Partial<RemoteAppControlHost> = {}): RemoteAppControlHost {
  return {
    getState: async () => state,
    execute: async (action) => ({ action }),
    ...overrides
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Remote Controller Agent', () => {
  it('uses the original request for a workbench task', async () => {
    const request = '  先看看构建错误，然后把注册表修好并运行测试。\n'
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response('{"kind":"WORKBENCH"}'))
    vi.stubGlobal('fetch', fetch)
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn(async (prompt: string) => ({ summary: `done:${prompt}`, changedFiles: ['src/main/Test.java'] }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    const result = await agent.handle(request)
    expect(run).toHaveBeenCalledWith(request, expect.any(Object))
    expect(execute).toHaveBeenCalledWith({ type: 'open_page', page: 'workspace' })
    expect(result).toMatchObject({ status: 'COMPLETED', text: `done:${request.replace(/。(?=\s*$)/u, '')}` })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}')) as { model?: string; reasoning_effort?: string }
    expect(body).toMatchObject({ model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' })
  })

  it('uses the active quota model preference instead of pinning the controller to Terra', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response('{"kind":"APP_CONTROL","actions":[{"type":"open_page","page":"settings"}],"reply":"ok"}'))
    vi.stubGlobal('fetch', fetch)
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'glm-4.7', reasoningEffort: 'high' }),
      host(),
      { run: vi.fn() }
    )
    await agent.handle('打开设置')
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? '{}')) as { model?: string; reasoning_effort?: string }
    expect(body).toMatchObject({ model: 'glm-4.7', reasoning_effort: 'high' })
  })

  it('executes app actions without starting the workbench', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"open_page","page":"settings"}],"reply":"已打开设置。"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn()
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('打开设置')).resolves.toMatchObject({ status: 'COMPLETED', text: '已打开设置' })
    expect(execute).toHaveBeenCalledWith({ type: 'open_page', page: 'settings' })
    expect(run).not.toHaveBeenCalled()
  })

  it('executes multiple app actions sequentially', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"open_page","page":"settings"},{"type":"set_app_setting","key":"darkMode","value":true}],"reply":"已打开设置并启用深色模式。"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn()
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('打开设置，然后修改为深色模式')).resolves.toMatchObject({ status: 'COMPLETED', text: '已打开设置并启用深色模式' })
    expect(execute).toHaveBeenNthCalledWith(1, { type: 'open_page', page: 'settings' })
    expect(execute).toHaveBeenNthCalledWith(2, { type: 'set_app_setting', key: 'darkMode', value: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('blocks an unspecified continuation even after multiple app actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"open_page","page":"settings"},{"type":"minimize"}],"reply":"已处理"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run: vi.fn() }
    )
    await expect(agent.handle('打开设置并最小化，然后继续')).resolves.toMatchObject({ status: 'COMPLETED', text: '你要求切换或调整后继续执行，但没有说明要继续做什么；请补充具体的项目任务' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('splits mixed requests and waits for app actions before workbench execution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"MIXED","actions":[{"type":"select_project","projectId":"project-1"}],"workbenchPrompt":"给这个项目添加一个方块。"}')))
    const order: string[] = []
    const execute = vi.fn(async () => { order.push('app'); return { success: true } })
    const run = vi.fn(async () => { order.push('workbench'); return { summary: '已完成' } })
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('打开 Demo，然后添加一个方块')).resolves.toMatchObject({ status: 'COMPLETED', text: '已完成' })
    expect(order).toEqual(['app', 'app', 'workbench'])
    expect(execute).toHaveBeenLastCalledWith({ type: 'open_page', page: 'workspace' })
    expect(run).toHaveBeenCalledWith('给这个项目添加一个方块', expect.any(Object))
  })

  it('does not call the workbench when no project is open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"WORKBENCH"}')))
    const run = vi.fn()
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ getState: async () => ({ ...state, currentProject: null }) }),
      { run }
    )
    await expect(agent.handle('给项目添加功能')).resolves.toMatchObject({ status: 'COMPLETED', text: '当前还没有打开项目，请先打开一个项目' })
    expect(run).not.toHaveBeenCalled()
  })

  it('routes project creation to app control and keeps the workbench for the follow-up task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"MIXED","actions":[{"type":"create_project","name":"新项目","loader":"fabric","minecraftVersion":"1.21.1","kind":"mod"}],"workbenchPrompt":"hi"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn(async () => ({ summary: 'hi 已发送' }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await agent.handle('帮我新建一个项目，然后在工作台发个hi')
    expect(execute).toHaveBeenNthCalledWith(1, { type: 'create_project', name: '新项目', loader: 'fabric', minecraftVersion: '1.21.1', kind: 'mod' })
    expect(execute).toHaveBeenLastCalledWith({ type: 'open_page', page: 'workspace' })
    expect(run).toHaveBeenCalledWith('hi', expect.any(Object))
  })

  it('does not execute an ambiguous destructive request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn()
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('把之前的东西清掉')).resolves.toMatchObject({ status: 'COMPLETED', text: '这个请求涉及删除、清理或覆盖，但目标不明确。请说明具体项目、文件或目录' })
    expect(fetch).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('asks which window operation is intended', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const execute = vi.fn(async (action) => ({ action }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run: vi.fn() }
    )
    await expect(agent.handle('把窗口收起来')).resolves.toMatchObject({ status: 'COMPLETED', text: '请说明要关闭独立窗口，还是最小化 ModMind 主窗口' })
    expect(fetch).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not execute an app-only decision when it contains an unspecified follow-up', async () => {
    const fetch = vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"select_project","projectId":"project-1"}],"reply":"已切换"}'))
    vi.stubGlobal('fetch', fetch)
    const execute = vi.fn(async (action) => ({ action }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run: vi.fn() }
    )
    await expect(agent.handle('切到另一个，然后接着做')).resolves.toMatchObject({ status: 'COMPLETED', text: '你要求切换或调整后继续执行，但没有说明要继续做什么；请补充具体的项目任务' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('also blocks an app action followed by a vague continue instruction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"close_window"}],"reply":"已关闭"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run: vi.fn() }
    )
    await expect(agent.handle('关掉没用的，再继续')).resolves.toMatchObject({ status: 'COMPLETED', text: '你要求切换或调整后继续执行，但没有说明要继续做什么；请补充具体的项目任务' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('routes diagnostic requests to the workbench when the model misclassifies them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"open_page","page":"settings"}],"reply":"Remote 正常"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn(async (prompt: string) => ({ summary: `诊断:${prompt}` }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('看看是不是哪里坏了')).resolves.toMatchObject({ status: 'COMPLETED', text: '诊断:看看是不是哪里坏了' })
    expect(execute).toHaveBeenCalledWith({ type: 'open_page', page: 'workspace' })
    expect(execute).not.toHaveBeenCalledWith({ type: 'open_page', page: 'settings' })
    expect(run).toHaveBeenCalledWith('看看是不是哪里坏了', expect.any(Object))
  })

  it('requires both app actions and a workbench task for mixed decisions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"MIXED","actions":[],"workbenchPrompt":"继续做"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const run = vi.fn()
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run }
    )
    await expect(agent.handle('切换项目并继续')).resolves.toMatchObject({ status: 'COMPLETED', text: '混合请求缺少明确的 ModMind 应用操作，请重新说明要切换或执行的应用动作' })
    expect(execute).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('still allows a plain project switch without a follow-up task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"kind":"APP_CONTROL","actions":[{"type":"select_project","projectId":"project-1"}],"reply":"已切换项目"}')))
    const execute = vi.fn(async (action) => ({ action }))
    const agent = new RemoteControllerAgent(
      async () => ({ baseUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
      host({ execute }),
      { run: vi.fn() }
    )
    await expect(agent.handle('切换项目')).resolves.toMatchObject({ status: 'COMPLETED', text: '已切换项目' })
    expect(execute).toHaveBeenCalledWith({ type: 'select_project', projectId: 'project-1' })
  })
})
