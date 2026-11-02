/** Public keyboard vocabulary: Java bindings use their own codes, never OS input. */
export const GAME_KEYS: Record<string, readonly [glfw: number, lwjgl2: number]> = {
  A: [65, 30], B: [66, 48], C: [67, 46], D: [68, 32], E: [69, 18], F: [70, 33], G: [71, 34], H: [72, 35], I: [73, 23], J: [74, 36], K: [75, 37], L: [76, 38], M: [77, 50], N: [78, 49], O: [79, 24], P: [80, 25], Q: [81, 16], R: [82, 19], S: [83, 31], T: [84, 20], U: [85, 22], V: [86, 47], W: [87, 17], X: [88, 45], Y: [89, 21], Z: [90, 44],
  '0': [48, 11], '1': [49, 2], '2': [50, 3], '3': [51, 4], '4': [52, 5], '5': [53, 6], '6': [54, 7], '7': [55, 8], '8': [56, 9], '9': [57, 10],
  Escape: [256, 1], Enter: [257, 28], Tab: [258, 15], Backspace: [259, 14], Insert: [260, 210], Delete: [261, 211], Right: [262, 205], Left: [263, 203], Down: [264, 208], Up: [265, 200], PageUp: [266, 201], PageDown: [267, 209], Home: [268, 199], End: [269, 207],
  Space: [32, 57], Shift: [340, 42], Control: [341, 29], Alt: [342, 56], Super: [343, 219], ShiftRight: [344, 54], ControlRight: [345, 157], AltRight: [346, 184], SuperRight: [347, 220],
  F1: [290, 59], F2: [291, 60], F3: [292, 61], F4: [293, 62], F5: [294, 63], F6: [295, 64], F7: [296, 65], F8: [297, 66], F9: [298, 67], F10: [299, 68], F11: [300, 87], F12: [301, 88],
  Minus: [45, 12], Equal: [61, 13], BracketLeft: [91, 26], BracketRight: [93, 27], Backslash: [92, 43], Semicolon: [59, 39], Quote: [39, 40], Backquote: [96, 41], Comma: [44, 51], Period: [46, 52], Slash: [47, 53], CapsLock: [280, 58], NumLock: [282, 69], ScrollLock: [281, 70], Pause: [284, 197], PrintScreen: [283, 183],
  Numpad0: [320, 82], Numpad1: [321, 79], Numpad2: [322, 80], Numpad3: [323, 81], Numpad4: [324, 75], Numpad5: [325, 76], Numpad6: [326, 77], Numpad7: [327, 71], Numpad8: [328, 72], Numpad9: [329, 73], NumpadDecimal: [330, 83], NumpadDivide: [331, 181], NumpadMultiply: [332, 55], NumpadSubtract: [333, 74], NumpadAdd: [334, 78], NumpadEnter: [335, 156]
}
export function gameKeyCode(value: unknown, family: 'glfw' | 'lwjgl2' | 'sdl'): number {
  if (typeof value !== 'string') throw new Error('key 需要标准按键名称')
  const aliases: Record<string, string> = { esc: 'Escape', return: 'Enter', ctrl: 'Control', spacebar: 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', leftshift: 'Shift', leftcontrol: 'Control', leftalt: 'Alt' }
  const stripped = value.replace(/^key\.keyboard\./i, '')
  const name = aliases[stripped.toLowerCase()] ?? Object.keys(GAME_KEYS).find(key => key.toLowerCase() === stripped.toLowerCase())
  if (!name || !GAME_KEYS[name]) throw new Error(`不支持的按键 ${value}；请使用字母、数字、F1–F12 或标准名称`)
  return GAME_KEYS[name][family === 'lwjgl2' ? 1 : 0]
}

export interface GameCaptureView {
  path: string; dataUrl: string; mimeType: 'image/png'; width: number; height: number
  logicalWidth: number; logicalHeight: number; framebufferWidth: number; framebufferHeight: number
  frameId: number; capturedAt: number; actionSequence: number; revision: string
}
export interface GameControlView {
  sessionId?: string; backend?: string; mode?: string; status?: string; ready?: boolean; running?: boolean; phase?: string; error?: string
  ownership?: 'ai' | 'paused' | 'human'; revision?: string; currentAction?: { requestId: string; status: string }; captures?: GameCaptureView[]
}

const number = { type: 'number' }, integer = { type: 'integer' }, text = { type: 'string' }
const duration = { type: 'integer', minimum: 1, maximum: 5000 }
const actionProperties = {
  operation: { type: 'string', enum: ['click', 'double_click', 'move', 'look', 'drag', 'scroll', 'text', 'key', 'key_down', 'key_up', 'button_down', 'button_up', 'combo', 'wait', 'inventory', 'close', 'command', 'interact', 'release', 'cancel', 'batch', 'operator'] },
  key: { type: 'string', maxLength: 80 }, keys: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: text }, durationMs: duration,
  x: { type: 'number', minimum: 0, maximum: 16384 }, y: { type: 'number', minimum: 0, maximum: 16384 }, toX: { type: 'number', minimum: 0, maximum: 16384 }, toY: { type: 'number', minimum: 0, maximum: 16384 },
  dx: { type: 'number', minimum: -4096, maximum: 4096 }, dy: { type: 'number', minimum: -4096, maximum: 4096 },
  button: { type: 'integer', minimum: 0, maximum: 7 }, clicks: { type: 'number', minimum: -100, maximum: 100 }, horizontal: { type: 'number', minimum: -100, maximum: 100 },
  text: { type: 'string', maxLength: 512 }, command: { type: 'string', maxLength: 500 }, pressEnter: { type: 'boolean' },
  slot: integer, yaw: number, pitch: number, enabled: { type: 'boolean' }
}
const schema = (properties: object, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const id = { type: 'string', minLength: 1, maxLength: 120 }
const requestId = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const steps = { type: 'array', minItems: 1, maxItems: 32, items: schema(actionProperties, ['operation']) }
export const GAME_TEST_SCHEMAS = {
  session: schema({ operation: { type: 'string', enum: ['capabilities', 'start', 'state', 'stop', 'pause', 'resume', 'takeover'] }, sessionId: id, waitSeconds: { type: 'number', minimum: 0, maximum: 20 },
    mode: { type: 'string', enum: ['headless', 'rendered'] }, backend: { type: 'string', enum: ['background', 'legacy'] }, offline: { type: 'boolean' }, username: { type: 'string', maxLength: 16 }, acceptEula: { type: 'boolean' }, hidden: { type: 'boolean' },
    withoutProjectMod: { type: 'boolean' }, maxMemoryMb: { type: 'integer', minimum: 1024, maximum: 16384 }, width: { type: 'integer', minimum: 640, maximum: 3840 }, height: { type: 'integer', minimum: 360, maximum: 2160 }, readyTimeoutMs: { type: 'integer', minimum: 30000, maximum: 900000 }
  }, ['operation']),
  observe: schema({ sessionId: id, operation: { type: 'string', enum: ['state', 'gui', 'logs', 'result'] }, requestId, after: integer, tooltip: integer }, ['sessionId']),
  capture: schema({ sessionId: id }, ['sessionId']),
  action: schema({ ...actionProperties, sessionId: id, revision: { type: 'string', maxLength: 200 }, requestId, capture: { type: 'boolean' }, steps }, ['operation', 'sessionId']),
  scenario: schema({ sessionId: id, steps: { type: 'array', minItems: 1, maxItems: 20, items: schema({ ...actionProperties, expect: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 500 } } }, ['operation', 'expect']) } }, ['sessionId', 'steps'])
}

/** Validate the finite schema vocabulary above for every business-service caller. */
export function validateGameTestInput(category: string, input: unknown): void {
  type Rule = { type?: string; enum?: readonly unknown[]; properties?: Record<string, Rule>; required?: readonly string[]; additionalProperties?: boolean; items?: Rule; minItems?: number; maxItems?: number; uniqueItems?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string }
  const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)
  const rule = (GAME_TEST_SCHEMAS as Record<string, Rule>)[category]
  if (!rule || !own(GAME_TEST_SCHEMAS, category)) throw new Error('不支持的后台控制类别')
  const invalid = (name: string): never => { throw new Error(`后台测试参数无效：${name}`) }
  function check(rule: Rule, value: unknown, name: string): void {
    if (rule.enum && !rule.enum.includes(value)) invalid(name)
    if (rule.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name)
      const object = value as Record<string, unknown>, properties = rule.properties ?? {}
      for (const key of rule.required ?? []) if (!own(object, key)) invalid(name + '.' + key)
      for (const key of Object.keys(object)) {
        if (!own(properties, key)) { if (rule.additionalProperties === false) invalid(name + '.' + key); continue }
        check(properties[key], object[key], name + '.' + key)
      }
    } else if (rule.type === 'array') {
      if (!Array.isArray(value)) invalid(name)
      const array = value as unknown[]
      if (array.length < (rule.minItems ?? 0) || array.length > (rule.maxItems ?? Infinity)) invalid(name)
      if (rule.uniqueItems && new Set(array.map(item => JSON.stringify(item))).size !== array.length) invalid(name)
      if (rule.items) array.forEach((item, index) => check(rule.items!, item, `${name}[${index}]`))
    } else if (rule.type === 'string') {
      if (typeof value !== 'string') invalid(name)
      const string = value as string
      if (string.length < (rule.minLength ?? 0) || string.length > (rule.maxLength ?? Infinity) || rule.pattern && !new RegExp(rule.pattern).test(string)) invalid(name)
    } else if (rule.type === 'number' || rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || rule.type === 'integer' && !Number.isInteger(value) || (value as number) < (rule.minimum ?? -Infinity) || (value as number) > (rule.maximum ?? Infinity)) invalid(name)
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') invalid(name)
  }
  check(rule, input, category)
}
export const GAME_TEST_DESCRIPTIONS = {
  session: 'Manage an owned game session: capabilities/start/state/stop, pause/resume AI input or takeover for human input. Rendered Java mod/modpack/plugin sessions default to the bundled background Agent, independent of control Mod catalogs. Start returns sessionId immediately; poll state until ready. The game retains real rendering and independent virtual input; hidden/minimized/locked states are not guaranteed. Legacy backend remains explicit; headless cannot prove visuals. Stop only owned processes.',
  observe: 'Read current background input/render state or bounded client logs. operation=result with requestId checks an earlier action without repeating it. Background observations do not invent GUI, inventory or world semantics. Use test_capture for visible evidence.',
  action: 'Operate the game through virtual keyboard/mouse: click/double_click, move, look(dx,dy relative pixels), drag(x,y,toX,toY), scroll, text, key/key_down/key_up, button_down/button_up, combo(keys), wait or batch(steps). Screenshot pixel coordinates require revision from latest test_capture; resizing/recreating invalidates it. Hold leases <=5000ms; batch <=32 steps and 10s. requestId deduplicates retries; query observe result after uncertainty. capture=true returns a later real image. release/cancel clear owned input. inventory/close use E/Escape; command types chat and needs in-game permissions. Completion means input and later render processed, never gameplay success.',
  capture: 'Capture a fresh real framebuffer image, returned as MCP image content with frameId, timestamp, dimensions and revision. Click/drag/move use pixels of this returned image, not desktop coordinates. Paused/human sessions remain observable. No stale frames or headless images are presented as current visuals.',
  scenario: 'Legacy backend text-assertion scenarios. For background sessions use test_action batch followed by capture and inspect the actual image; no semantic game-state assertions are fabricated.'
}
