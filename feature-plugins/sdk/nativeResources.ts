import path from 'node:path'

let installedDirectory: string | undefined
export function configureNativeFeatureResources(directory: string | undefined): void {
  installedDirectory = directory
}

export function nativeFeatureResourcePath(...segments: string[]): string | undefined {
  return installedDirectory ? path.join(installedDirectory, 'assets', ...segments) : undefined
}
