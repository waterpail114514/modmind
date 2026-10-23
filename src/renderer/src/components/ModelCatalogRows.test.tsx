import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ModelCatalogRows, { filterModelCatalog, groupModelCatalog, modelCatalogCurrent, modelCatalogDefaultSelection, modelCatalogFamilies, modelCatalogFailure, modelCatalogForProvider, modelCatalogKey, modelCatalogProvider, modelCatalogProviders, modelCatalogRouteLabel, modelCatalogSelection, partitionModelCatalog, readModelRouteChoices, rememberModelRoutes } from './ModelCatalogRows'
import ModelProviderSelect from './ModelProviderSelect'
import { quotaModelDisplayMetadata, quotaModelOptionKey } from '../../../shared/quotaModels'
import type { AiModelInfo } from '../../../shared/types'

const option = (id: string, account = 'ls', group: string | null = '25', extra: Partial<AiModelInfo> = {}): AiModelInfo => ({
  id, account, group, billing: account.startsWith('trial:') ? 'free' : 'quota', available: true, modelEvidence: 'verified',
  optionKey: quotaModelOptionKey(id, account.startsWith('trial:') ? 'free' : 'quota', account, group), ...extra
})

describe('unified model and precise line choices', () => {
  it('folds undescribed GPT variants while preserving every supplier and free route', () => {
    const models = [option('gpt-6.1-sol'), option('gpt-4o'), option('gpt-4o', 'secondary', 'other'), option('gpt-4o', 'trial:one', null), option('gpt-reserve'), option('future-model')]
    const result = partitionModelCatalog(groupModelCatalog(models))
    expect(result.primary.map(group => group.id)).toEqual(['gpt-6.1-sol', 'future-model'])
    expect(result.additionalGpt.map(group => group.id)).toEqual(['gpt-4o', 'gpt-reserve'])
    expect(result.additionalGpt[0].routes).toHaveLength(3)
    const markup = renderToStaticMarkup(createElement(ModelCatalogRows, { models, onSelect: () => undefined }))
    expect(markup).toContain('<details class="model-catalog-more"><summary>')
    expect(markup).toContain('更多 GPT 模型')
  })

  it('keeps selected or failing supplementary models outside the collapsed section', () => {
    const selected = option('gpt-4o'), failed = option('gpt-reserve')
    const result = partitionModelCatalog(groupModelCatalog([selected, failed, option('gpt-4o-mini')]), modelCatalogKey(selected), '', failed.id)
    expect(result.primary.map(group => group.id)).toEqual(['gpt-4o', 'gpt-reserve'])
    expect(result.additionalGpt.map(group => group.id)).toEqual(['gpt-4o-mini'])
  })

  it('searches supplementary models directly and honors upstream descriptions and recommendations', () => {
    const groups = groupModelCatalog([option('gpt-4o'), option('gpt-reserve'), option('gpt-new', 'ls', '25', { description: '上游模型说明' }), option('gpt-recommended', 'ls', '25', { recommended: true })])
    expect(partitionModelCatalog(groups).primary.map(group => group.id)).toEqual(['gpt-new', 'gpt-recommended'])
    expect(partitionModelCatalog(groups, undefined, 'gpt').additionalGpt).toEqual([])
    expect(partitionModelCatalog(groups, undefined, 'gpt').primary).toEqual(groups)
  })

  it('merges the same model across suppliers without losing any exact route', () => {
    const models = [option('future-model'), option('future-model', 'ls', '74'), option('future-model', 'trial:one', null), option('future-model', 'secondary', 'other')]
    const grouped = groupModelCatalog(models)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].routes).toHaveLength(4)
    expect(new Set(grouped.flatMap(group => group.routes.map(modelCatalogKey))).size).toBe(4)
    const markup = renderToStaticMarkup(createElement(ModelCatalogRows, { models, onSelect: () => undefined }))
    expect(markup.match(/data-model-id=/g)).toHaveLength(1)
    expect(markup).toContain('选择 future-model 的线路')
    expect(markup).toContain('可免费')
    expect(modelCatalogForProvider(models, 'ls')).toEqual(models.slice(0, 2))
    expect(filterModelCatalog(models, '全部', 'trial:one')).toEqual(models)
  })

  it('keeps the selected free route, its paid alternatives and a working line chooser in one row', () => {
    const paid = option('glm-5.3', 'secondary', 'GLM', { providerLabel: '供应商2', groupLabel: 'GLM线路' })
    const free = option('glm-5.3', 'trial:one', null, { providerLabel: '免费套餐' })
    const key = modelCatalogKey(free)
    const group = groupModelCatalog([paid, free], key)[0]
    expect(group.preferred).toBe(free)
    expect(modelCatalogSelection(free)).toEqual({ account: 'trial:one', billing: 'free' })
    expect(modelCatalogSelection({ ...free, group: 'stale-paid-group' })).not.toHaveProperty('group')
    const markup = renderToStaticMarkup(createElement(ModelCatalogRows, { models: [paid, free], currentKey: key, onSelect: () => undefined }))
    expect(markup).toContain('class="quota-free-mark model-catalog-free" aria-label="免费版">免</sup>')
    expect(markup).toContain('选择 GLM 5.3 的线路')
    expect(markup).toContain('免费套餐')
    expect(markup).not.toContain('额度')
    expect(markup).not.toContain('可免费')
  })

  it('keeps both paid suppliers distinct when upstream group IDs are identical', () => {
    const ls = option('gpt-6.1-sol', 'ls', 'shared-group', { providerLabel: 'LS', groupLabel: '标准组' })
    const secondary = option('gpt-6.1-sol', 'secondary', 'shared-group', { providerLabel: '供应商 2', groupLabel: '标准组' })
    const free = option('gpt-6.1-sol', 'trial:one', null, { providerLabel: '免费套餐' })
    const selected = modelCatalogKey(secondary)
    const group = groupModelCatalog([ls, secondary, free], selected)[0]
    expect(group.routes.map(modelCatalogKey)).toHaveLength(3)
    expect(new Set(group.routes.map(modelCatalogKey)).size).toBe(3)
    expect(group.preferred).toBe(secondary)
    expect(modelCatalogSelection(group.preferred)).toEqual({ account: 'secondary', group: 'shared-group', billing: 'quota' })
    expect(modelCatalogCurrent(group.routes, 'gpt-6.1-sol', 'ls', 'shared-group')).toBe(ls)
    expect(filterModelCatalog(group.routes, '全部', 'LS', selected)).toEqual(group.routes)
    const markup = renderToStaticMarkup(createElement(ModelCatalogRows, { models: group.routes, currentKey: selected, onSelect: () => undefined }))
    expect(markup.match(/data-model-id=/g)).toHaveLength(1)
    expect(markup).toContain('供应商 2 · 标准组')
    expect(markup).toContain('可免费')
    expect(markup).not.toContain('model-provider-picker')
  })

  it('never advertises a broken free route as a usable free alternative', () => {
    const paid = option('glm-5.3', 'secondary', 'GLM')
    const free = option('glm-5.3', 'trial:one', null, { available: false })
    const markup = renderToStaticMarkup(createElement(ModelCatalogRows, { models: [paid, free], onSelect: () => undefined }))
    expect(markup).not.toContain('model-catalog-free')
    expect(groupModelCatalog([paid, free])[0].routes).toHaveLength(2)
  })

  it('prefers the selected exact group and keeps each model selection precise', () => {
    const standard = option('future-model', 'ls', '25', { groupLabel: '标准组', providerLabel: 'LS' })
    const stable = option('future-model', 'ls', '74', { groupLabel: '稳定组', providerLabel: 'LS', routeCurrent: true })
    expect(groupModelCatalog([standard, stable], modelCatalogKey(standard))[0].preferred).toBe(standard)
    expect(groupModelCatalog([standard, stable])[0].preferred).toBe(stable)
    expect(modelCatalogSelection(stable)).toEqual({ account: 'ls', billing: 'quota', group: '74' })
    expect(modelCatalogRouteLabel(stable)).toBe('LS · 稳定组')
    expect(modelCatalogSelection(stable)).not.toHaveProperty('allowModelChange')
  })

  it('keeps another model on its own prepared route when the active model changes groups or suppliers', () => {
    const standard = option('current', 'ls', '25', { routeCurrent: true })
    const switched = option('current', 'secondary', 'other')
    const nextStandard = option('next', 'ls', '25', { routeCurrent: true })
    const nextSwitched = option('next', 'secondary', 'other')
    const models = [standard, switched, nextStandard, nextSwitched]
    const choices = rememberModelRoutes({}, groupModelCatalog(models, modelCatalogKey(standard)))
    const updated = models.map(model => ({ ...model, routeCurrent: model.account === 'secondary' }))
    const groups = groupModelCatalog(updated, modelCatalogKey(switched), choices)
    expect(groups.find(group => group.id === 'current')?.preferred.account).toBe('secondary')
    expect(groups.find(group => group.id === 'next')?.preferred.account).toBe('ls')
    const remembered = rememberModelRoutes(choices, groups)
    expect(remembered.next).toBe(modelCatalogKey(nextStandard))
    expect(remembered.current).toBe(modelCatalogKey(switched))
  })

  it('keeps a locally chosen free route until activation and only then prefers the confirmed current route', () => {
    const paid = option('next'), free = option('next', 'trial:one', null)
    const choices = { next: modelCatalogKey(free) }
    expect(groupModelCatalog([paid, free], undefined, choices)[0].preferred).toBe(free)
    expect(modelCatalogSelection(groupModelCatalog([paid, free], undefined, choices)[0].preferred)).toEqual({ account: 'trial:one', billing: 'free' })
    expect(groupModelCatalog([paid, free], modelCatalogKey(paid), choices)[0].preferred).toBe(paid)
  })

  it('preserves an unavailable prepared route for an explicit new choice instead of silently changing billing', () => {
    const paid = option('next'), free = option('next', 'trial:one', null, { available: false })
    const group = groupModelCatalog([paid, free], undefined, { next: modelCatalogKey(free) })[0]
    expect(group.preferred).toBe(free)
    expect(modelCatalogDefaultSelection(group)).toBeUndefined()
  })

  it('bounds and validates local route preferences while preserving choices hidden by a filter', () => {
    expect(readModelRouteChoices('invalid')).toEqual({})
    expect(readModelRouteChoices('["invalid"]')).toEqual({})
    expect(readModelRouteChoices('{"valid":"route","bad":false}')).toEqual({ valid: 'route' })
    const saved = readModelRouteChoices(JSON.stringify(Object.fromEntries(Array.from({ length: 1100 }, (_, i) => ['model-' + i, 'route-' + i]))))
    expect(Object.keys(saved)).toHaveLength(1024)
    const next = rememberModelRoutes(saved, groupModelCatalog([option('visible')]))
    expect(Object.keys(next)).toHaveLength(1024)
    expect(next['model-1099']).toBe('route-1099')
    expect(rememberModelRoutes(next, groupModelCatalog([option('visible')], undefined, next))).toBe(next)
  })

  it('never automatically selects an unverified group when only candidates exist', () => {
    const models = [option('future-model', 'ls', '74', { modelEvidence: 'unknown' }), option('future-model', 'ls', 'other', { modelEvidence: 'unknown' })]
    expect(modelCatalogDefaultSelection(groupModelCatalog(models)[0])).toBeUndefined()
    expect(modelCatalogForProvider(models, 'ls')).toEqual([])
    expect(renderToStaticMarkup(createElement(ModelCatalogRows, { models, onSelect: () => undefined }))).toContain('选线路')
    const verified = option('future-model', 'ls', '25')
    expect(modelCatalogDefaultSelection(groupModelCatalog([...models, verified])[0])).toBe(verified)
  })

  it('keeps connected empty suppliers visible and scopes hundreds without adding model placeholders', () => {
    const models = [option('known', 'ls', '25')]
    const connections = [{ account: 'ls', label: 'LS', kind: 'paid' as const }, ...Array.from({ length: 255 }, (_, index) => ({ account: `trial:${index}`, label: `免费套餐 ${index}`, kind: 'free' as const }))]
    const providers = modelCatalogProviders(models, connections)
    expect(providers).toHaveLength(256)
    expect(modelCatalogProvider(models, 'ls', 'trial:254', providers)).toBe('trial:254')
    expect(modelCatalogForProvider(models, 'trial:254')).toEqual([])
    expect(modelCatalogProvider(models, 'retired', undefined, providers)).toBe('ls')
    expect(modelCatalogProviders(models, [])).toEqual([])
    expect(modelCatalogProvider(models, 'ls', undefined, [])).toBeUndefined()
    expect(modelCatalogProviders(models, connections).filter(provider => provider.billing === 'free')).toHaveLength(255)
    const single = renderToStaticMarkup(createElement(ModelProviderSelect, { providers: providers.slice(0, 1), value: 'ls', onChange: () => undefined }))
    expect(single).not.toContain('button')
    expect(single).toContain('LS')
  })

  it('shows short business errors without Electron transport wrappers', () => {
    expect(modelCatalogFailure(new Error("Error invoking remote method 'device:selectModel': Error: 已切换线路，但本组不支持所选模型"))).toBe('该线路暂不支持此模型，请刷新后重新选择。')
    expect(modelCatalogFailure(new Error("Error invoking remote method 'device:selectModel': Error: 请在官网切换付费供应商后重新同步"))).toBe('请在官网切换付费供应商后重新同步')
  })

  it('honors a saved group pin without treating another active group as the same selection', () => {
    const pinned = option('future-model', 'ls', '25', { routeCurrent: false })
    const actual = option('future-model', 'ls', '74', { routeCurrent: true })
    expect(modelCatalogCurrent([pinned, actual], 'future-model', 'ls', '25')).toBe(pinned)
    expect(modelCatalogCurrent([pinned, actual], 'future-model', 'ls', 'missing')).toBeUndefined()
    expect(modelCatalogCurrent([pinned, actual], 'future-model', 'ls')).toBe(actual)
    expect(modelCatalogCurrent([pinned, actual], 'future-model', 'secondary', '25')).toBeUndefined()
  })

  it('finds a route by label without hiding other routes for the same model', () => {
    const standard = option('future-model', 'ls', '25', { groupLabel: '标准组' })
    const stable = option('future-model', 'ls', '74', { groupLabel: '稳定组' })
    expect(filterModelCatalog([standard, stable], '全部', '稳定组')).toEqual([standard, stable])
  })

  it('keeps unknown model catalogs usable without static recommendations or free placeholders', () => {
    const models = [option('new-chat'), option('future-model')]
    expect(filterModelCatalog(models, '推荐', '')).toHaveLength(2)
    expect(modelCatalogFamilies(models)).toEqual(['推荐', '其他', '全部'])
    expect(filterModelCatalog([...models, option('gpt-6.1-sol', 'ls', '25', { available: false })], '推荐', '')).toHaveLength(3)
    expect(filterModelCatalog([...models, option('gpt-6.1-sol')], '推荐', '', modelCatalogKey(models[0])).map(model => model.id)).toEqual(['gpt-6.1-sol', 'new-chat'])
  })

  it('retains bounded upstream display metadata instead of requiring a bundled model ID', () => {
    const model = option('vendor/custom-chat', 'ls', '25', { name: 'New upstream model', family: 'Custom', description: 'Provider description', recommended: true })
    expect(quotaModelDisplayMetadata(model)).toMatchObject({ name: 'New upstream model', family: 'Custom', recommended: true })
    expect(modelCatalogFamilies([model])).toContain('Custom')
    expect(filterModelCatalog([model], 'GPT', 'new upstream')).toEqual([model])
  })
})
