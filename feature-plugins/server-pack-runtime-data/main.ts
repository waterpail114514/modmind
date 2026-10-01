import path from 'node:path'
export function activate(options: { pluginDirectory: string }) {
  return { resource: () => path.join(options.pluginDirectory, 'assets', 'chunks', 'server-pack-creator.part') }
}
