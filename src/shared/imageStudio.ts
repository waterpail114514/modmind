export type ImageStudioStyle = 'minecraft' | 'free'
export type ImageStudioQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageStudioModeration = 'auto' | 'low'
export type ImageStudioBackground = 'solid' | 'auto'
export type ImageStudioSource = 'manual' | 'agent'

export interface ImageStudioSettings {
  baseUrl: string
  model: string
  hasStoredKey: boolean
  allowAgentImages: boolean
  autoApproveAgentImages: boolean
  manualHostedConsent: boolean
}

export interface ImageStudioSettingsInput {
  baseUrl: string
  model: string
  apiKey: string
  clearApiKey?: boolean
  allowAgentImages: boolean
  autoApproveAgentImages: boolean
  manualHostedConsent: boolean
}

export interface ImageStudioCapabilities {
  models: string[]
  sizes: string[]
  qualities: ImageStudioQuality[]
  moderations: ImageStudioModeration[]
  supportsImageInput: boolean
  supportsMask: boolean
}

export interface ImageGenerationRequest {
  prompt: string
  style: ImageStudioStyle
  size: string
  quality: ImageStudioQuality
  moderation: ImageStudioModeration
  count: number
  background: ImageStudioBackground
  backgroundColor: string
  removeBackground: boolean
  source: ImageStudioSource
  referenceImage?: string
}

export interface ImageAsset {
  id: string
  dataUrl: string
  createdAt: string
  model: string
  style: ImageStudioStyle
  size: string
  quality: ImageStudioQuality
  hosted: boolean
  credits: number
}

export interface ImageGenerationResult {
  jobId: string
  assets: ImageAsset[]
  hosted: boolean
  credits: number
  revisedPrompt?: string
  /** A later request failed; assets contains the images already generated. */
  error?: string
}

export interface ImageHistoryItem extends Omit<ImageAsset, 'dataUrl'> {
  projectRelativePath?: string
}

export type PerfectPixelSampleMethod = 'majority' | 'center' | 'median'

export interface PerfectPixelOptions {
  sampleMethod?: PerfectPixelSampleMethod
  gridSize?: [number, number]
  minSize?: number
  peakWidth?: number
  refineIntensity?: number
  fixSquare?: boolean
}

export interface ImageProcessingOptions {
  perfectPixel?: PerfectPixelOptions
}

export interface ImageProcessingResult {
  dataUrl: string
  operation: 'perfect-pixel' | 'remove-background'
  detail: string
}
