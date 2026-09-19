import { describe, expect, it } from 'vitest'
import { disabledWorkbenchFeature, normalizeWorkbenchFeatures, readWorkbenchFeatureSelection } from './workbenchFeatures'

describe('workbench feature selection', () => {
  it('requires explicit booleans when normalizing an existing selection', () => {
    expect(normalizeWorkbenchFeatures({ renderedTesting: 'true', headlessTesting: true, modeling: 1 })).toEqual({ renderedTesting: false, headlessTesting: true, imageGeneration: false, modeling: false })
    expect(Object.values(normalizeWorkbenchFeatures(null))).toEqual([false, false, false, false])
  })

  it('starts with every box checked and preserves explicit unchecked preferences', () => {
    expect(Object.values(readWorkbenchFeatureSelection(null))).toEqual([true, true, true, true])
    expect(Object.values(readWorkbenchFeatureSelection('invalid json'))).toEqual([true, true, true, true])
    expect(readWorkbenchFeatureSelection('{"headlessTesting":false,"renderedTesting":true,"imageGeneration":true,"modeling":true}')).toEqual({ headlessTesting: false, renderedTesting: true, imageGeneration: true, modeling: true })
  })

  it('retains builds and cleanup while preventing alternate test entry points', () => {
    const features = normalizeWorkbenchFeatures({})
    for (const [action, input] of [['build_project', {}], ['test_matrix', { targets: ['build'] }], ['test_session', { operation: 'stop' }], ['server_operation', { operation: 'stop' }]] as const) {
      expect(disabledWorkbenchFeature(features, action, input)).toBeUndefined()
    }
    for (const [action, input] of [['test_matrix', { targets: ['build', 'client'] }], ['test_minecraft', {}], ['server_operation', { operation: 'start' }], ['modpack_verify_server_join', {}], ['modpack_run_server_scenario', {}]] as const) {
      expect(disabledWorkbenchFeature(features, action, input)).toBe('headlessTesting')
    }
    expect(disabledWorkbenchFeature(features, 'test_rendered')).toBe('renderedTesting')
    expect(disabledWorkbenchFeature(undefined, 'test_minecraft')).toBeUndefined()
  })
})
