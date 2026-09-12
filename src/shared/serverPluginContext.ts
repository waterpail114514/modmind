import type { ProjectInfo } from './types'

export function serverPluginContext(project: ProjectInfo, readOnly = false): string {
  if (project.kind !== 'server-plugin') return ''
  return `SERVER PLUGIN PROJECT: ${project.name}; platform/API ${project.loader} ${project.apiVersion ?? project.minecraftVersion}; Java ${project.javaVersion ?? 'resolve from build'}.
${readOnly ? 'Discuss requirements and compatibility only; do not edit, download, build or launch.' : 'Implement in the existing project. Use modmind_build_project, modmind_local_server and modmind_resource_pack for managed build/test/resource operations. Never route this plugin to Fabric/Forge or a client mods directory.'}
Inspect plugin.yml, paper-plugin.yml or Velocity metadata and Gradle/Maven before changing code. Use platform API, compileOnly for server APIs, and separate runtime plugin dependencies in server-plugins/. Preserve existing commands, permissions and data. Handle player/console permissions, async I/O, lifecycle cleanup, and explicit Folia scheduler ownership. Velocity is a proxy API, not Bukkit. Prefer mature libraries only when needed; Vault requires an actual economy provider. Do not claim compatibility from compilation alone; report core readiness, plugin enablement and scenario evidence separately.
For implementation, migration or runtime investigation, use minecraft-server-plugin-development from the supplied skill directory. Bound caches and work queues; release owned tasks, pools, listeners and player/world references on their lifecycle boundaries. Verify async completion after disconnect/disable and measure repeated workload cleanup before claiming memory safety.
Resource packs live in resource-packs/<id>/ with pack.mcmeta and assets/. Reuse the resource pack workspace and existing image/model tools. Exported resources are separate from the plugin JAR unless the project explicitly embeds them.`
}
