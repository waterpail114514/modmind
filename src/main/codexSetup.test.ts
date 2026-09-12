import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_RUNTIME_VERSION, clearPreparedCodexCredentials, getPreparedCodexEnvironment, getPreparedCodexExecutable, isManagedCodexVersion, managedCodexExecutablePath, managedCodexRuntimePath, prepareCodex, type CodexServerConfig } from './codexSetup'

vi.mock('./codexExecutable', async (importOriginal) => ({ ...await importOriginal<typeof import('./codexExecutable')>(), probeCodexExecutable: vi.fn(async () => '0.154.0') }))

const settings = {
  apiKey: 'test-key',
  baseUrl: 'https://provider.example/v1',
  model: 'test-model',
  reasoningEffort: 'high'
} satisfies CodexServerConfig

describe('Codex beginner preparation', () => {
  afterEach(() => {
    delete process.env.MODMIND_CODEX_CONFIG_URL
    clearPreparedCodexCredentials()
  })

  it('accepts only the exact managed Codex runtime version', () => {
    expect(isManagedCodexVersion('codex-cli 0.154.0')).toBe(true)
    expect(isManagedCodexVersion('v0.154.0')).toBe(true)
    expect(isManagedCodexVersion('codex-cli 0.144.3')).toBe(false)
    expect(isManagedCodexVersion('codex-cli 0.154.0-alpha')).toBe(false)
    expect(isManagedCodexVersion(undefined)).toBe(false)
  })

  it('uses one deterministic runtime location for settings and quota workflows', () => {
    const root = path.join('C:', 'ModMindData')
    const runtime = managedCodexRuntimePath(root, 'win32', 'x64')
    expect(runtime).toBe(path.join(root, 'codex-runtime', `${CODEX_RUNTIME_VERSION}-win32-x64`))
    expect(managedCodexExecutablePath(root, 'win32', 'x64')).toBe(path.join(runtime, 'package', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'))
  })

  it('writes an isolated config and skips the second identical write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-'))
    try {
      const bundledSkillsDir = path.join(root, 'bundled-skills')
      await fs.mkdir(path.join(bundledSkillsDir, 'headless-minecraft-testing'), {recursive: true})
      await fs.writeFile(path.join(bundledSkillsDir, 'headless-minecraft-testing', 'SKILL.md'), '---\nname: headless-minecraft-testing\ndescription: Test\n---\n')
      const first = await prepareCodex({rootDir: root, serverConfig: settings, existingExecutable: 'C:\\codex.exe', bundledSkillsDir})
      expect(first.configChanged).toBe(true)
      expect(first.configSource).toBe('local-settings')
      expect(await fs.readFile(first.configPath, 'utf8')).toContain('model = "test-model"')
      expect(await fs.readFile(first.configPath, 'utf8')).toContain('model_reasoning_effort = "high"')
      expect(await fs.readFile(first.configPath, 'utf8')).toContain('enable_request_compression = false')
      expect(await fs.readFile(path.join(root, 'codex-home', 'skills', 'headless-minecraft-testing', 'SKILL.md'), 'utf8')).toContain('headless-minecraft-testing')

      const second = await prepareCodex({rootDir: root, serverConfig: settings, existingExecutable: 'C:\\codex.exe', bundledSkillsDir})
      expect(second.configChanged).toBe(false)
    } finally {
      await fs.rm(root, {recursive: true, force: true})
    }
  })

  it('clears device credentials after a quota task without touching the managed config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-clear-'))
    try {
      const result = await prepareCodex({
        rootDir: root,
        serverConfig: settings,
        configSource: 'device',
        existingExecutable: 'C:\\codex.exe'
      })
      expect(getPreparedCodexEnvironment()).toMatchObject({ MODMIND_THIRD_PARTY_API_KEY: 'test-key' })
      expect(getPreparedCodexExecutable()).toBe('C:\\codex.exe')

      clearPreparedCodexCredentials()

      expect(getPreparedCodexEnvironment()).toEqual({})
      expect(getPreparedCodexExecutable()).toBeUndefined()
      await expect(fs.readFile(result.configPath, 'utf8')).resolves.not.toContain('test-key')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('continues when the optional bundled skills directory is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-missing-skills-'))
    try {
      const result = await prepareCodex({
        rootDir: root,
        serverConfig: settings,
        existingExecutable: 'C:\\codex.exe',
        bundledSkillsDir: path.join(root, 'resources', 'codex-skills')
      })
      expect(result.configChanged).toBe(true)
      await expect(fs.readFile(result.configPath, 'utf8')).resolves.toContain('model = "test-model"')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an external provider setup isolated from a prepared quota Codex runtime', async () => {
    const quotaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-quota-'))
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-external-'))
    try {
      await prepareCodex({
        rootDir: quotaRoot,
        serverConfig: settings,
        existingExecutable: 'C:\\quota-codex.exe'
      })

      const external = await prepareCodex({
        rootDir: externalRoot,
        serverConfig: { ...settings, apiKey: 'external-key' },
        existingExecutable: 'C:\\external-codex.exe',
        rememberPrepared: false
      })

      expect(external.environment).toMatchObject({ CODEX_HOME: external.home, MODMIND_THIRD_PARTY_API_KEY: 'external-key' })
      expect(getPreparedCodexExecutable()).toBe('C:\\quota-codex.exe')
      expect(getPreparedCodexEnvironment()).toMatchObject({ MODMIND_THIRD_PARTY_API_KEY: 'test-key' })
    } finally {
      await fs.rm(quotaRoot, { recursive: true, force: true })
      await fs.rm(externalRoot, { recursive: true, force: true })
    }
  })

  it('keeps runtime cache and per-run Codex homes separate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-codex-homes-'))
    try {
      const firstHome = path.join(root, 'project-a-home')
      const secondHome = path.join(root, 'project-b-home')
      const first = await prepareCodex({rootDir: root, homeDir: firstHome, serverConfig: settings, existingExecutable: 'C:\\codex.exe', rememberPrepared: false})
      const second = await prepareCodex({rootDir: root, homeDir: secondHome, serverConfig: {...settings, model: 'other-model'}, existingExecutable: 'C:\\codex.exe', rememberPrepared: false})
      expect(first.home).toBe(firstHome)
      expect(second.home).toBe(secondHome)
      await expect(fs.readFile(first.configPath, 'utf8')).resolves.toContain('model = "test-model"')
      await expect(fs.readFile(second.configPath, 'utf8')).resolves.toContain('model = "other-model"')
    } finally {
      await fs.rm(root, {recursive: true, force: true})
    }
  })
})
