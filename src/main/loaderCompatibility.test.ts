import { describe, expect, it } from 'vitest'
import {
  buildJavaRangeForProject,
  gradleWrapperProperties,
  javaRuntimeTargetForMinecraft,
  javaVersionForMinecraft,
  loaderBuildCompatibility,
  supportsProjectCreation
} from './loaderCompatibility'

describe('loader build compatibility', () => {
  it('enforces official template support boundaries', () => {
    for (const loader of ['fabric', 'forge', 'neoforge', 'paper', 'spigot', 'folia'] as const) {
      expect(supportsProjectCreation(loader, '26.3')).toBe(true)
      expect(supportsProjectCreation(loader, '26.4')).toBe(false)
    }
    expect(supportsProjectCreation('quilt', '26.3')).toBe(false)
    expect(supportsProjectCreation('fabric', '1.20.1')).toBe(true)
    expect(supportsProjectCreation('quilt', '1.21.1')).toBe(false)
    expect(supportsProjectCreation('forge', '1.12.2')).toBe(true)
    expect(supportsProjectCreation('forge', '1.6.3')).toBe(false)
    expect(supportsProjectCreation('neoforge', '1.20.1')).toBe(false)
    expect(supportsProjectCreation('neoforge', '1.20.4')).toBe(true)
  })

  it('selects Java 25 and epsilon for Minecraft 26.2', () => {
    expect(javaVersionForMinecraft('26.2')).toBe(25)
    expect(javaRuntimeTargetForMinecraft('26.2')).toBe('java-runtime-epsilon')
    expect(javaRuntimeTargetForMinecraft('1.21.11')).toBe('java-runtime-delta')
    expect(buildJavaRangeForProject({ loader: 'fabric', minecraftVersion: '1.14.4' })).toEqual({ minimum: 21 })
    expect(buildJavaRangeForProject({ loader: 'forge', minecraftVersion: '1.12.2' })).toEqual({ minimum: 8, maximum: 8 })
  })

  it('pins official Gradle/plugin generations and distribution checksums', () => {
    expect(loaderBuildCompatibility('fabric', '26.3')).toMatchObject({ javaVersion: 25, gradleVersion: '9.6.0', pluginVersion: '1.17.21' })
    expect(loaderBuildCompatibility('forge', '26.3')).toMatchObject({ javaVersion: 25, gradleVersion: '9.7.1' })
    expect(loaderBuildCompatibility('neoforge', '26.3')).toMatchObject({ javaVersion: 25, gradleVersion: '9.2.1', pluginVersion: '2.0.148' })
    expect(javaRuntimeTargetForMinecraft('26.3')).toBe('java-runtime-epsilon')
    expect(loaderBuildCompatibility('fabric', '1.21.11')).toMatchObject({ gradleVersion: '9.5.1', pluginVersion: '1.17.17' })
    expect(loaderBuildCompatibility('quilt', '1.21')).toMatchObject({ gradleVersion: '8.9', pluginVersion: '1.7.4' })
    expect(loaderBuildCompatibility('forge', '1.20.1')).toMatchObject({ gradleVersion: '8.12.1', pluginVersion: '6.0.54' })
    expect(loaderBuildCompatibility('forge', '1.8.9')).toMatchObject({ gradleVersion: '2.7', pluginVersion: '2.1.6' })
    expect(loaderBuildCompatibility('forge', '1.12.2')).toMatchObject({ gradleVersion: '4.9', pluginVersion: '3.0.197' })
    expect(loaderBuildCompatibility('forge', '1.21.11')).toMatchObject({ gradleVersion: '9.5.0', pluginVersion: '7.0.31' })
    expect(loaderBuildCompatibility('neoforge', '1.21.11')).toMatchObject({ gradleVersion: '9.2.1', pluginVersion: '2.0.143' })
    expect(gradleWrapperProperties({ loader: 'fabric', minecraftVersion: '1.21.11' })).toMatch(/distributionSha256Sum=[a-f0-9]{64}/)
    expect(gradleWrapperProperties({ loader: 'forge', minecraftVersion: '1.8.9' })).toContain('mirrors.huaweicloud.com/gradle/gradle-2.7-bin.zip')
  })
})
