import { archiveEntries, archiveRead } from './ftbResourceArchive'

export async function validateJavaArchive(file: string, options: { installer?: boolean; executable?: boolean } = {}): Promise<void> {
  try {
    const entries = await archiveEntries(file)
    if (!entries.some(name => name.endsWith('.class'))) throw new Error('JAR 缺少 Java 类文件')
    if (options.installer) {
      const profile = JSON.parse((await archiveRead(file, 'install_profile.json')).toString('utf8'))
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('安装器配置无效')
    }
    if (options.executable) {
      const manifest = (await archiveRead(file, 'META-INF/MANIFEST.MF')).toString('utf8').replace(/\r?\n /g, '')
      const main = manifest.match(/^Main-Class:\s*(\S+)\s*$/im)?.[1]
      if (!main || !entries.includes(`${main.replaceAll('.', '/')}.class`)) throw new Error('JAR 缺少可运行入口')
    }
  } catch (cause) {
    throw Object.assign(new Error(`JAR 内容校验失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause }), { name: 'InvalidZipError' })
  }
}
