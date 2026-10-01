import path from 'node:path'
import type { LoaderKind, ProjectInfo } from "../../../../src/shared/types"
import { javaRuntimeTargetForMinecraft } from "../../../../src/main/loaderCompatibility"

export interface RuntimeMetadata {
  minecraftVersion: string
  loader: LoaderKind
  loaderVersionId: string
  fabricVersionId?: string
  loaderVersion: string
  javaPath: string
  javaTarget: string
  /** 'custom' marks a user-picked Java home whose absolute path must survive normalization. */
  javaSource?: 'managed' | 'custom'
  preparedAt: string
}

export function managedJavaExecutable(runtimeRoot: string, target: string, platform = process.platform): string {
  return path.join(runtimeRoot, target, 'bin', platform === 'win32' ? 'java.exe' : 'java')
}

/**
 * Runtime metadata travels with a project, but the managed JDK lives under
 * the current user's ModMind data directory. Rebuild that absolute path when
 * reading a project copied from another user or machine.
 */
export function normalizeRuntimeMetadata(
  project: ProjectInfo,
  metadata: Partial<RuntimeMetadata>,
  runtimeRoot: string
): RuntimeMetadata | null {
  if (metadata.minecraftVersion !== project.minecraftVersion) return null
  const loader = metadata.loader ?? (metadata.fabricVersionId ? 'fabric' : undefined)
  const loaderVersionId = metadata.loaderVersionId ?? metadata.fabricVersionId
  if (
    loader !== project.loader
    || typeof loaderVersionId !== 'string'
    || !loaderVersionId
    || typeof metadata.loaderVersion !== 'string'
    || !metadata.loaderVersion
    || typeof metadata.javaPath !== 'string'
    || !metadata.javaPath
    || typeof metadata.preparedAt !== 'string'
    || !metadata.preparedAt
  ) return null

  const javaTarget = javaRuntimeTargetForMinecraft(project.minecraftVersion)
  // A manually selected Java lives outside the ModMind data directory, so its
  // recorded path is already machine-local and must not be rewritten to the
  // managed layout.
  const customJava = metadata.javaSource === 'custom'
  return {
    minecraftVersion: project.minecraftVersion,
    loader,
    loaderVersionId,
    fabricVersionId: metadata.fabricVersionId,
    loaderVersion: metadata.loaderVersion,
    javaPath: customJava ? metadata.javaPath : managedJavaExecutable(runtimeRoot, javaTarget),
    javaSource: customJava ? 'custom' : 'managed',
    javaTarget,
    preparedAt: metadata.preparedAt
  }
}
