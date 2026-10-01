/** XMCL appends the Minecraft version to Forge 1.7.x/1.8.x artifact versions. */
export function forgeInstallerVersion(minecraftVersion: string, loaderVersion: string): string {
  const prefix = `${minecraftVersion}-`
  let version = loaderVersion.startsWith(prefix) ? loaderVersion.slice(prefix.length) : loaderVersion
  if (/^1\.(?:7|8)\./.test(minecraftVersion) && version.endsWith(`-${minecraftVersion}`)) {
    version = version.slice(0, -(minecraftVersion.length + 1))
  }
  return version
}
