import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureDevelopmentPaths } from './developmentPaths'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-dev-paths-'))
  roots.push(root)
  return { root, app: { isPackaged: false, getAppPath: () => root,
    commandLine: { getSwitchValue: vi.fn(() => '') }, setPath: vi.fn(), setAppLogsPath: vi.fn() } }
}

it('separates two workspaces and directs Chromium state and logs to their own profile', async () => {
  const a = await fixture(), b = await fixture()
  const profileA = configureDevelopmentPaths(a.app, {})
  const profileB = configureDevelopmentPaths(b.app, {})
  expect(profileA).not.toBe(profileB)
  expect(profileA).toBe(path.join(a.root, '.modmind-dev/userData'))
  expect(a.app.setPath.mock.calls).toEqual([['userData', profileA], ['sessionData', profileA]])
  expect(a.app.setAppLogsPath).toHaveBeenCalledWith(path.join(profileA!, 'logs'))
  expect((await fs.stat(path.join(profileA!, 'logs'))).isDirectory()).toBe(true)
})

it('preserves production identity even when a development override is present', async () => {
  const { root, app } = await fixture()
  app.isPackaged = true
  expect(configureDevelopmentPaths(app, { MODMIND_DEV_USER_DATA_DIR: root })).toBeUndefined()
  expect(app.setPath).not.toHaveBeenCalled()
  expect(app.setAppLogsPath).not.toHaveBeenCalled()
})

it('honors explicit smoke profiles before the development environment override', async () => {
  const { root, app } = await fixture()
  const manual = path.join(root, 'manual'), smoke = path.join(root, 'smoke')
  expect(configureDevelopmentPaths(app, { MODMIND_DEV_USER_DATA_DIR: manual })).toBe(manual)
  app.commandLine.getSwitchValue.mockReturnValue(smoke)
  expect(configureDevelopmentPaths(app, { MODMIND_DEV_USER_DATA_DIR: manual })).toBe(smoke)
})

it('rejects a relative override before changing any app paths', async () => {
  const { app } = await fixture()
  expect(() => configureDevelopmentPaths(app, { MODMIND_DEV_USER_DATA_DIR: '../profile' })).toThrow('absolute')
  expect(app.setPath).not.toHaveBeenCalled()
})
