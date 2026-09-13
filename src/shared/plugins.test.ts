import { describe, expect, it } from 'vitest'
import { isPluginPanelMessage, validatePluginManifest } from './plugins'

function baseManifest(): Record<string, unknown> {
  return {
    id: 'desktop-pet',
    name: 'Desktop Pet',
    version: '0.1.0',
    description: 'A cross-page overlay',
    permissions: []
  }
}

describe('plugin overlay manifest', () => {
  it('accepts the new host capabilities and validates generic context envelopes', () => {
    expect(validatePluginManifest({ ...baseManifest(), panel: { entry: 'index.html' }, permissions: ['ui.overlay', 'chat.read', 'chat.write', 'chat.context'] }).errors).toEqual([])
    expect(isPluginPanelMessage({ type: 'context', requestId: '1', op: 'overlayClose' })).toBe(true)
    expect(isPluginPanelMessage({ type: 'context', requestId: '1', op: 'chatSetDraft', args: { text: 'hi' } })).toBe(true)
    expect(isPluginPanelMessage({ type: 'context', requestId: '1', op: 'chatSetDraft', args: [] })).toBe(false)
    expect(isPluginPanelMessage({ type: 'context', requestId: '1', op: 123 })).toBe(false)
  })
  it('accepts an overlay as the only plugin entry', () => {
    const result = validatePluginManifest({
      ...baseManifest(),
      overlay: { entry: 'overlay/index.html', mode: 'pet', width: 220, height: 260, alwaysOnTop: true }
    })
    expect(result.errors).toEqual([])
    expect(result.manifest?.overlay).toEqual({ entry: 'overlay/index.html', mode: 'pet', width: 220, height: 260, alwaysOnTop: true })
  })

  it('rejects unsafe overlay dimensions and modes', () => {
    const result = validatePluginManifest({
      ...baseManifest(),
      overlay: { entry: 'overlay/index.html', mode: 'fullscreen', width: 5000, height: 20 }
    })
    expect(result.manifest).toBeUndefined()
    expect(result.errors.join('\n')).toContain('overlay.mode')
    expect(result.errors.join('\n')).toContain('overlay.width')
    expect(result.errors.join('\n')).toContain('overlay.height')
  })
})
