import type { ShaderInventory, ShaderIssue, ShaderOption } from '../../../../src/shared/shaderStudio'

// Iris OptionAnnotatedSource's supported const names, not arbitrary shader constants.
const constNames = new Set(['shadowMapResolution', 'shadowDistance', 'voxelDistance', 'shadowDistanceRenderMul',
  'entityShadowDistanceMul', 'shadowIntervalSize', 'generateShadowMipmap', 'generateShadowColorMipmap',
  'shadowHardwareFiltering', 'shadowtex0Mipmap', 'shadowtexMipmap', 'shadowtex1Mipmap', 'shadowtex0Nearest',
  'shadowtexNearest', 'shadow0MinMagNearest', 'shadowtex1Nearest', 'shadow1MinMagNearest', 'wetnessHalflife',
  'drynessHalflife', 'eyeBrightnessHalflife', 'centerDepthHalflife', 'sunPathRotation', 'ambientOcclusionLevel',
  'superSamplingLevel', 'noiseTextureResolution'])
const constName = (name: string) => constNames.has(name) || /^(?:shadow[Cc]olor\d+(?:Mipmap|Nearest|MinMagNearest)|shadowHardwareFiltering\d+)$/.test(name)
const tokenValue = /^[A-Za-z0-9_.+-]+$/
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fF]?$/
export const programName = /^(?:world-?\d+\/)?[A-Za-z0-9_]+$/
export function maskBlockComments(source: string): string {
  // Keep newlines and offsets so edits address the original source line.
  return source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, comment => comment.replace(/[^\r\n]/g, ' '))
}
interface Property { key: string; value: string; line: number }
function properties(source: string): Property[] {
  const rows: Property[] = [], lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1; let text = lines[i]
    if (/^\s*[#!]/.test(text)) continue
    let continuations = 0
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(text) && i + 1 < lines.length) {
      if (++continuations > 128) break
      text = text.slice(0, -1) + lines[++i].trimStart()
    }
    const match = text.match(/^\s*([\w./-]+)\s*=\s*(.*?)\s*$/)
    if (match) rows.push({ key: match[1], value: match[2], line })
  }
  return rows
}
export function parseShaderOptions(sources: Array<{ path: string; content: string }>, config: string, language: string, programs: string[]): Pick<ShaderInventory,
  'options' | 'profiles' | 'profilePrograms' | 'profileIssues' | 'optionGroups' | 'optionIssues' | 'programConditions' | 'configurationConditional'> {
  const labels = new Map(properties(language).map(row => [row.key, row.value])), rows = properties(config)
  const candidates = new Map<string, ShaderOption>(), ambiguous = new Set<string>(), references = new Set<string>()
  const optionIssues: ShaderIssue[] = [], guards = new Set<string>()
  const masked = sources.map(file => ({ ...file, content: maskBlockComments(file.content) }))
  for (const file of masked) {
    const code = file.content.replace(/\/\/[^\r\n]*/g, '')
    for (const match of code.matchAll(/^\s*#(?:ifdef|ifndef)\s+(\w+)\b/gm)) references.add(match[1])
    for (const match of code.matchAll(/^\s*#ifndef\s+(\w+)\s*\n\s*#define\s+\1\s*$/gm)) guards.add(match[1])
    for (const match of code.matchAll(/^\s*#if\s+!\s*defined\s*\(\s*(\w+)\s*\)\s*\n\s*#define\s+\1\s*$/gm)) guards.add(match[1])
  }
  for (const file of masked) file.content.split(/\r?\n/).forEach((line, index) => {
    const define = line.match(/^\s*#define\s+(\w+)\s+([^\s/]+)\s*\/\/\s*\[([^\]]+)\]/)
    const toggle = line.match(/^\s*(\/\/\s*)?#define\s+(\w+)\s*(?:\/\/.*)?$/)
    const constant = line.match(/^\s*const\s+(int|float|bool)\s+(\w+)\s*=\s*([^\s;]+)\s*;\s*(?:\/\/\s*(?:\[([^\]]+)\])?.*)?$/)
    if (!define && !toggle && !constant) return
    const name = define?.[1] ?? toggle?.[2] ?? constant![2]
    if (guards.has(name) || toggle && !references.has(name) || constant && !constName(name)) return
    const value = define?.[2] ?? (toggle ? String(!toggle[1]) : constant![3])
    const list = define?.[3] ?? constant?.[4]
    const values = list ? list.trim().split(/\s+/) : toggle || constant?.[1] === 'bool' ? ['false', 'true'] : []
    if (values.length < 2 || values.length > 64 || !values.includes(value) || values.some(v => !tokenValue.test(v))) return
    if (constant && values.some(v => constant[1] === 'bool' ? !['true', 'false'].includes(v) : constant[1] === 'int' ? !/^[+-]?\d+$/.test(v) : !numeric.test(v))) return
    const declaration = define ? 'define' : toggle ? 'toggle' : 'const'
    const previous = candidates.get(name), location = { path: file.path, line: index + 1 }
    if (previous) {
      if (previous.value !== value || previous.declaration !== declaration || previous.values.join('\0') !== values.join('\0')) {
        ambiguous.add(name); optionIssues.push({ ...location, severity: 'warning', message: `选项 ${name} 的重复声明不一致，不能安全回写` })
      }
      previous.files.push(location)
    } else candidates.set(name, { name, title: labels.get(`option.${name}`) ?? name, value, values, files: [location], declaration })
  })
  for (const name of ambiguous) candidates.delete(name)
  const sliders = new Set(rows.filter(row => row.key === 'sliders').flatMap(row => row.value.split(/\s+/)))
  const options = [...candidates.values()].map(option => ({ ...option, slider: sliders.has(option.name) && option.values.every(value => numeric.test(value)) }))
  const definitions = new Map<string, Property>(), invalid = new Map<string, string[]>()
  for (const row of rows.filter(row => row.key.startsWith('profile.'))) {
    const name = row.key.slice(8)
    if (definitions.has(name)) invalid.set(name, [`预设 ${name} 重复声明`])
    definitions.set(name, row)
  }
  const profiles = new Map<string, Record<string, string>>(), profilePrograms = new Map<string, Record<string, boolean>>()
  const programSet = new Set(programs.map(name => name.replace(/^shaders\//, '')))
  const expand = (name: string, stack: string[]): void => {
    if (stack.includes(name) || stack.length >= 32) throw new Error(`预设继承循环或超过 32 层：${[...stack, name].join(' → ')}`)
    if (invalid.has(name)) throw new Error(invalid.get(name)!.join('；'))
    if (profiles.has(name)) return
    const row = definitions.get(name)
    if (!row) throw new Error(`继承的预设不存在：${name}`)
    const values = new Map<string, string>(), disabled = new Map<string, boolean>()
    for (const token of row.value.split(/\s+/).filter(Boolean)) {
      const parent = token.match(/^profile[.:]([\w-]+)$/)
      if (parent) {
        expand(parent[1], [...stack, name])
        for (const entry of Object.entries(profiles.get(parent[1])!)) values.set(...entry)
        for (const entry of Object.entries(profilePrograms.get(parent[1])!)) disabled.set(...entry)
        continue
      }
      if (token.startsWith('!program.')) {
        const program = token.slice(9)
        if (!programName.test(program) || !programSet.has(program)) throw new Error(`预设 ${name} 引用了不存在的程序：${program}`)
        disabled.set(program, false); continue
      }
      const assignment = token.match(/^(\w+)[=:]([A-Za-z0-9_.+-]+)$/), toggle = token.match(/^(!?)(\w+)$/)
      if (!assignment && !toggle) throw new Error(`预设 ${name} 的参数不受支持：${token}`)
      const optionName = assignment?.[1] ?? toggle![2], value = assignment?.[2] ?? String(!toggle![1])
      const option = candidates.get(optionName)
      if (!option || !option.values.includes(value)) throw new Error(`预设 ${name} 的选项或值无效：${optionName}=${value}`)
      values.set(optionName, value)
    }
    profiles.set(name, Object.fromEntries(values)); profilePrograms.set(name, Object.fromEntries(disabled))
  }
  for (const name of definitions.keys()) try { expand(name, []) } catch (error) { invalid.set(name, [String((error as Error).message)]) }
  const screens = new Map(rows.filter(row => row.key === 'screen' || /^screen\.[\w-]+$/.test(row.key) && !row.key.endsWith('.columns')).map(row => [row.key, row.value]))
  const optionGroups: ShaderInventory['optionGroups'] = [], assigned = new Set<string>(), expandedScreens = new Set<string>()
  const visitScreen = (key: string, stack: string[]) => {
    if (stack.includes(key) || stack.length >= 32) { optionIssues.push({ path: 'shaders/shaders.properties', severity: 'warning', message: `选项菜单循环或超过 32 层：${key}` }); return }
    if (expandedScreens.has(key)) return
    const text = screens.get(key)
    if (text === undefined) return
    expandedScreens.add(key)
    const names: string[] = []
    for (const token of text.split(/\s+/)) {
      const child = token.match(/^\[([\w-]+)\]$/)
      if (child) { visitScreen(`screen.${child[1]}`, [...stack, key]); continue }
      for (const name of token === '*' ? [...candidates.keys()] : [token]) if (candidates.has(name) && !assigned.has(name)) { assigned.add(name); names.push(name) }
    }
    if (names.length) optionGroups.push({ name: key, title: labels.get(key) ?? (key === 'screen' ? '通用' : key.slice(7)), options: names })
  }
  if (screens.has('screen')) visitScreen('screen', [])
  else for (const key of screens.keys()) visitScreen(key, [])
  const other = options.filter(option => !assigned.has(option.name)).map(option => option.name)
  if (other.length) optionGroups.push({ name: 'other', title: optionGroups.length ? '其他' : '选项', options: other })
  const programConditions = Object.fromEntries(rows.flatMap(row => {
    const match = row.key.match(/^program\.([A-Za-z0-9_/.-]+)\.enabled$/)
    return match && programName.test(match[1]) ? [[match[1], row.value]] : []
  }))
  const configurationConditional = /^\s*#\s*(?:if|ifdef|ifndef|elif|else)\b/m.test(config)
  if (configurationConditional) optionIssues.push({ path: 'shaders/shaders.properties', severity: 'warning', message: '配置包含条件分支；菜单与预设是源码声明，最终配置需由 Iris 确认，程序开关不可在此回写' })
  return { options, profiles: Object.fromEntries(profiles), profilePrograms: Object.fromEntries(profilePrograms),
    profileIssues: Object.fromEntries(invalid), optionGroups, optionIssues, programConditions,
    configurationConditional }
}
