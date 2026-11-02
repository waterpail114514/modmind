export function dataPackStarterMetadata(minecraftVersion: string, name: string): string {
  const description = `${name} data pack`
  const pack = minecraftVersion === '26.3'
    ? { description, min_format: [121, 0], max_format: [121, 0] }
    : { description, pack_format: minecraftVersion === '1.20.1' ? 15 : minecraftVersion === '1.20.6' ? 41 : 48 }
  return `${JSON.stringify({ pack }, null, 2)}\n`
}

export function dataPackStarterPath(minecraftVersion: string, path: string): string {
  return minecraftVersion === '26.3' ? path.replace('/functions/', '/function/') : path
}
