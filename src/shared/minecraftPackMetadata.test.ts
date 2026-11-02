import { expect, it } from 'vitest'
import { dataPackStarterMetadata, dataPackStarterPath } from './dataPackStarter'
import { resourcePackMetadata, resourcePackSupports263, suggestedResourcePackFormat } from './resourcePack'

it('generates 26.3 resource and data pack format ranges', () => {
  expect(suggestedResourcePackFormat('26.3')).toBe(97)
  expect(resourcePackMetadata('26.3', 97, 'Test')).toEqual({ pack: { description: 'Test', min_format: [97, 1], max_format: [97, 1] } })
  expect(JSON.parse(dataPackStarterMetadata('26.3', 'Test'))).toEqual({ pack: { description: 'Test data pack', min_format: [121, 0], max_format: [121, 0] } })
  expect(dataPackStarterPath('26.3', 'datapacks/data/example/functions/start.mcfunction')).toBe('datapacks/data/example/function/start.mcfunction')
  expect(resourcePackSupports263({ min_format: 97, max_format: 97 })).toBe(true)
  expect(resourcePackSupports263({ min_format: [97, 1], max_format: [97, 1] })).toBe(true)
  for (const pack of [{ pack_format: 97 }, { min_format: [97, 0], max_format: [97, 0] }, { min_format: [97, 2], max_format: 97 }, { min_format: [97, 1] }, { min_format: '97', max_format: 97 }]) expect(resourcePackSupports263(pack)).toBe(false)
  expect(resourcePackMetadata('1.21.1', 34, 'Test')).toEqual({ pack: { description: 'Test', pack_format: 34 } })
  expect(JSON.parse(dataPackStarterMetadata('1.20.1', 'Test')).pack.pack_format).toBe(15)
})
