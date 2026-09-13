/** Data only; model parsing stays in the bundled upstream Blockbench codecs. */
export interface ModelSourceDocument {
  name: string
  format: 'java_block' | 'bedrock' | 'project'
  model: Record<string, unknown>
  textures: Array<{ id: string; name: string; dataUrl: string }>
  animations: Array<{ name: string; content: string }>
}

export interface ResourceModelTarget {
  projectPath: string
  id: string
  file: string
  baseline: string
  projectUuid: string
}
