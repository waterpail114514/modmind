import { describe, expect, it } from 'vitest'
import { adoptiumMetadataUrl, jdkDownloadSources, ensureManagedJdk } from './jdkDownload'

describe('managed build JDK downloads', () => {
  it('cancels before provisioning a JDK when the caller is already aborted', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(ensureManagedJdk('unused-cache', 21, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('selects both native Mac architectures and rejects unsupported targets', () => {
    expect(adoptiumMetadataUrl(21, 'darwin', 'arm64')).toContain('architecture=aarch64')
    expect(adoptiumMetadataUrl(21, 'darwin', 'x64')).toContain('os=mac')
    expect(() => adoptiumMetadataUrl(21, 'darwin', 'ia32')).toThrow(/架构/)
    expect(() => adoptiumMetadataUrl(21, 'freebsd', 'x64')).toThrow(/平台/)
  })
  it('selects a full JDK and domestic mirror before the official source', () => {
    expect(adoptiumMetadataUrl(8, 'win32', 'x64')).toContain('/latest/8/hotspot?')
    expect(adoptiumMetadataUrl(8, 'win32', 'x64')).toContain('image_type=jdk')
    const sources = jdkDownloadSources('OpenJDK8U-jdk_x64_windows_hotspot_8u.zip', 8, 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8/file.zip', 'win32', 'x64')
    expect(sources[0]).toEqual({
      label: '清华大学 TUNA Adoptium 镜像',
      url: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/8/jdk/x64/windows/OpenJDK8U-jdk_x64_windows_hotspot_8u.zip'
    })
    expect(sources[1].label).toBe('中国科学技术大学 Adoptium 镜像')
    expect(sources[2].label).toBe('Eclipse Adoptium 官方源')
  })
})
