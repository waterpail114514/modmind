import { describe, expect, it } from 'vitest'
import { githubWorkflow, loaderMatrixWorkflow } from './workflowService'

describe('generated mod CI workflow', () => {
  it('builds on Windows and Linux and uploads the release JAR', () => {
    const result = githubWorkflow({ name: 'Test', path: '', loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'test_mod', createdAt: '', javaVersion: 21 })
    expect(result).toContain('ubuntu-latest, windows-latest')
    expect(result).toContain('gradle build --no-daemon --stacktrace')
    expect(result).toContain('build/libs/*.jar')
  })

  it('uses a compatible Gradle release for legacy Forge', () => {
    const result = githubWorkflow({ name: 'Legacy', path: '', loader: 'forge', minecraftVersion: '1.12.2', namespace: 'legacy_mod', createdAt: '', javaVersion: 8 })
    expect(result).toContain("gradle-version: '4.9'")
  })

  it('pins Quilt 1.20.1 to its compatible Gradle generation', () => {
    const result = githubWorkflow({ name: 'Quilt', path: '', loader: 'quilt', minecraftVersion: '1.20.1', namespace: 'quilt_mod', createdAt: '', javaVersion: 17 })
    expect(result).toContain("gradle-version: '8.9'")
  })

  it('covers Fabric, Quilt, Forge, and NeoForge in the real-loader workflow', () => {
    const result = loaderMatrixWorkflow()
    expect(result).toContain('loader: fabric')
    expect(result).toContain('loader: quilt')
    expect(result).toContain('loader: forge')
    expect(result).toContain('loader: neoforge')
    expect(result).toContain('actions/setup-java@v4')
    expect(result).toContain("minecraft: '26.2'")
    expect(result).toContain("minecraft: '26.3'")
    expect(result).toContain("apiVersion: '0.164.0+26.3'")
    expect(result).toContain('java: 25')
    expect(result).toContain("qslVersion: '10.0.0-alpha.1+1.21'")
    expect(result).toContain('pull_request:')
  })
})
