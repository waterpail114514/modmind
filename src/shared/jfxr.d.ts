declare module 'jfxr' {
  export interface Parameter { value: number | string | boolean; minValue: number | null; maxValue: number | null; values: Record<string, string> | null }
  export class Sound {
    name: string
    [key: string]: unknown
    serialize(): string
    parse(value: string): void
  }
  export class Clip { toWavBytes(): Uint8Array }
  export class Synth {
    constructor(settings: string)
    run(callback: (clip: Clip) => void): void
    cancel(): void
  }
  export interface Preset { name: string; applyTo?: (sound: Sound) => Sound }
  export const ALL_PRESETS: Preset[]
  export const Preset: { mutate(sound: Sound): void }
}
