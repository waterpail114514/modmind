import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  SERVER_PACK_CREATOR_MIN_JAVA,
  SERVER_PACK_CREATOR_FILE_NAME,
  SERVER_PACK_CREATOR_RESOURCE_DIRECTORY,
  SERVER_PACK_CREATOR_SHA256,
  SERVER_PACK_CREATOR_URL,
  SERVER_PACK_CREATOR_VERSION,
  serverPackCreatorBundledJarCandidates,
  serverPackCreatorCommand
} from "../../feature-plugins/testing/src/main/serverPackCreatorService"

describe('ServerPackCreator adapter', () => {
  it('pins the upstream CLI release and invokes its documented headless conversion mode', () => {
    expect(SERVER_PACK_CREATOR_VERSION).toBe('8.1.2')
    expect(SERVER_PACK_CREATOR_MIN_JAVA).toBe(21)
    expect(SERVER_PACK_CREATOR_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(SERVER_PACK_CREATOR_URL).toContain(`/releases/download/${SERVER_PACK_CREATOR_VERSION}/`)
    expect(serverPackCreatorCommand('tool.jar', 'serverpack.conf', 'server-pack', 'spc-home')).toEqual([
      '-jar', 'tool.jar', '-lang', 'en_us', '-config', 'serverpack.conf', '--destination', 'server-pack', '--home', 'spc-home'
    ])
  })

  it('uses the packaged resource first and retains a development-resource fallback', () => {
    expect(serverPackCreatorBundledJarCandidates('app-root', 'packaged-resources')).toEqual([
      path.join('packaged-resources', SERVER_PACK_CREATOR_RESOURCE_DIRECTORY, SERVER_PACK_CREATOR_FILE_NAME),
      path.join('app-root', 'resources', SERVER_PACK_CREATOR_RESOURCE_DIRECTORY, SERVER_PACK_CREATOR_FILE_NAME)
    ])
  })
})
