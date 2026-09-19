/**
 * Shared contract for exporting decompiled JAR sources as a ModMind self-made mod module.
 * Types live in `shared` so the renderer consent dialog and the main-process service stay
 * in sync; the terms text itself lives with the service implementation.
 */

export const DECOMPILE_TERMS_VERSION = '1.0.0'

/** Written into each generated module; acknowledgement JSON sits beside it under `.modmind/`. */
export const DECOMPILE_TERMS_FILE = 'docs/decompiled-sources-terms.md'
export const DECOMPILE_ACKNOWLEDGEMENT_FILE = '.modmind/decompile-terms-acknowledgement.json'
export const DECOMPILE_PROVENANCE_COPY = 'docs/decompiled-source-provenance.json'

export const DECOMPILE_TERMS_TITLE = '反编译源码使用条款与免责声明'

export interface DecompileTermsSection {
  heading: string
  body: string[]
}

/** Payload returned by the decompile:getTerms IPC for the renderer's consent dialog. */
export interface DecompileTermsPayload {
  version: string
  title: string
  sections: DecompileTermsSection[]
  rendered: string
}

export interface CreatedModuleFromDecompiled {
  name: string
  namespace: string
  relativePath: string
  fileCount: number
  termsFilePath: string
  acknowledgementPath: string
  provenanceCopyPath: string
}

/** Input for creating a standalone ModMind Java project from a decompiled cache entry. */
export interface CreateProjectFromDecompiledInput {
  sourceSha256: string
  name: string
  loader: import('./decompile').DecompilePlatform
  minecraftVersion: string
  termsAcknowledgement: {
    termsVersion: string
    acknowledged: true
    origin?: 'user-workspace' | 'ai-action'
  }
}
