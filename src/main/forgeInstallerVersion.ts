/** XMCL appends the Minecraft version to Forge 1.7.x/1.8.x artifact versions. */
export function forgeInstallerVersion(minecraftVersion: string, loaderVersion: string): string {
  const prefix = `${minecraftVersion}-`
  let version = loaderVersion.startsWith(prefix) ? loaderVersion.slice(prefix.length) : loaderVersion
  if (/^1\.(?:7|8)\./.test(minecraftVersion) && version.endsWith(`-${minecraftVersion}`)) {
    version = version.slice(0, -(minecraftVersion.length + 1))
  }
  return version
}

/** Preserve catalog artifact spelling; some old builds use no suffix or -mc172. */
export function forgeInstallerUrl(minecraftVersion: string, loaderVersion: string): string {
  if (!/^\d+(?:\.\d+){1,2}$/.test(minecraftVersion) || !/^[A-Za-z0-9._-]+$/.test(loaderVersion)) throw new Error('Forge 安装器版本无效')
  const prefix = minecraftVersion + '-'
  let artifact = loaderVersion.startsWith(prefix) ? loaderVersion : prefix + loaderVersion
  if (!loaderVersion.startsWith(prefix) && ['1.7.10', '1.8.9'].includes(minecraftVersion) && !artifact.endsWith('-' + minecraftVersion)) artifact += '-' + minecraftVersion
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`
}
