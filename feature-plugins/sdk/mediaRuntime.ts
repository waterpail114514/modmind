import { nativeFeatureFunction } from '../../src/main/nativeFeatureServices'

/** Shared by media features; no converter binary is shipped with the core app. */
export const mediaExecutable = nativeFeatureFunction<(name?: string) => string>('media-runtime', 'executable')
