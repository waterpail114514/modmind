import { describe, expect, it } from 'vitest'
import { studioCreationRecords, studioRecords, type StudioDefinition } from './studios'
import type { FeaturePluginCatalogEntry, FeaturePluginRecord } from './featurePlugins'

const definition: StudioDefinition = {
  apiVersion: 1, id: 'document', name: '文稿工作台', projectKind: 'document', loaders: ['markdown'],
  defaultTarget: { loader: 'markdown', version: '1' }, templateHandler: 'document',
  creation: { fields: [{ id: 'name', title: '文稿名称', type: 'input', bind: 'name' }] },
  ai: { workbench: { instructions: 'Write', skills: [] }, inspiration: { instructions: 'Discuss', skills: [] } }
}
const plugin: FeaturePluginRecord = { id: 'document-studio', name: '文稿工作台', version: '1', enabled: true,
  manifest: { format: 'modmind-feature', hostVersion: '1.5.0-plugintest', main: 'main.cjs', renderer: 'renderer.js', style: 'renderer.css', id: 'document-studio', name: '文稿工作台', version: '1', apiVersion: 2, studios: [definition] } }
const entry: FeaturePluginCatalogEntry = { ...plugin, installed: true, available: true, state: 'ready', installHint: '' }

describe('installed creation contributions', () => {
  it('keeps missing domain identity for recovery while hiding its form', () => {
    expect(studioRecords([{ ...entry, installed: false, available: false, state: 'not-installed' }])).toHaveLength(1)
    expect(studioCreationRecords([], [entry])).toEqual([])
    for (const state of ['disabled', 'error', 'dependency-missing', 'not-installed'] as const) {
      expect(studioCreationRecords([plugin], [{ ...entry, available: false, state }])).toEqual([])
    }
  })
  it('uses the installed manifest and excludes providers without forms or with renderer errors', () => {
    const catalog = [{ ...entry, manifest: { ...plugin.manifest!, studios: [{ ...definition, name: 'Stale catalog' }] } }]
    expect(studioCreationRecords([plugin], catalog)[0].definition.name).toBe('文稿工作台')
    expect(studioCreationRecords([{ ...plugin, error: 'renderer failed' }], catalog)).toEqual([])
    expect(studioCreationRecords([{ ...plugin, manifest: { ...plugin.manifest!, studios: [{ ...definition, creation: undefined }] } }], catalog)).toEqual([])
  })
})
