import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import asm from '@xmcl/asm'

// Static inspection of only the small input-library JARs. Never fetches a game JAR.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, 'test-results/game-control-version-audit')
const output = path.join(root, 'docs/game-control-compatibility')
const offline = process.argv.includes('--offline')
const artifacts = JSON.parse(await fs.readFile(path.join(output, 'input-artifacts.json'), 'utf8'))
const { ClassReader, ClassVisitor, Opcodes } = asm
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n')
await fs.mkdir(path.join(cache, 'input-jars'), { recursive: true })
const archiveModule = path.join(cache, 'archive-inspection.mjs')
await build({ entryPoints: [path.join(root, 'src/main/archiveInspection.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: archiveModule, logLevel: 'silent' })
const { archiveRead } = await import(pathToFileURL(archiveModule).href)

const legacy = {
  'org/lwjgl/input/Keyboard.class': ['poll', 'next', 'isKeyDown', 'getEventKey', 'getEventKeyState', 'getEventCharacter', 'getEventNanoseconds', 'enableRepeatEvents'],
  'org/lwjgl/input/Mouse.class': ['poll', 'next', 'isButtonDown', 'getX', 'getY', 'getDX', 'getDY', 'getDWheel', 'getEventButton', 'getEventButtonState', 'getEventX', 'getEventY', 'getEventDX', 'getEventDY', 'getEventDWheel', 'setCursorPosition', 'setGrabbed', 'isGrabbed'],
  'org/lwjgl/opengl/Display.class': ['update', 'processMessages', 'isActive', 'isVisible', 'swapBuffers', 'getWidth', 'getHeight']
}
const modern = {
  'org/lwjgl/glfw/GLFW.class': ['glfwPollEvents', 'glfwWaitEvents', 'glfwWaitEventsTimeout', 'glfwGetKey', 'glfwGetMouseButton', 'glfwGetCursorPos', 'glfwSetCursorPos', 'glfwGetInputMode', 'glfwSetInputMode', 'glfwGetWindowAttrib', 'glfwSetKeyCallback', 'glfwSetCharCallback', 'glfwSetMouseButtonCallback', 'glfwSetCursorPosCallback', 'glfwSetScrollCallback', 'glfwSetWindowFocusCallback', 'glfwSetWindowIconifyCallback', 'glfwGetFramebufferSize', 'glfwSwapBuffers']
}
const sdl = {
  'org/lwjgl/sdl/SDLEvents.class': ['SDL_PollEvent', 'SDL_GetWindowFromEvent'],
  'org/lwjgl/sdl/SDLKeyboard.class': ['SDL_GetKeyboardState', 'SDL_GetModState', 'SDL_GetKeyFromScancode'],
  'org/lwjgl/sdl/SDLMouse.class': ['SDL_GetMouseState', 'SDL_GetRelativeMouseState', 'SDL_SetWindowRelativeMouseMode', 'SDL_WarpMouseInWindow'],
  'org/lwjgl/sdl/SDLVideo.class': ['SDL_CreateWindow', 'SDL_GetWindowFlags', 'SDL_GetWindowSizeInPixels', 'SDL_SetWindowFocusable']
}

class Methods extends ClassVisitor {
  constructor() { super(Opcodes.ASM5); this.methods = [] }
  visitMethod(access, name, descriptor) {
    this.methods.push({ name, descriptor, access, native: Boolean(access & 0x100), static: Boolean(access & 0x8), abstract: Boolean(access & 0x400) })
    return null
  }
}

let downloadedBytes = 0
const results = []
for (const artifact of artifacts) {
  const result = { name: artifact.name, sha1: artifact.sha1, url: artifact.url, family: artifact.family, staticStatus: 'pending', runtimeVerified: false }
  try {
    const jar = path.join(cache, 'input-jars', `${artifact.sha1}.jar`)
    let bytes = await fs.readFile(jar).catch(() => null)
    if (bytes && hash(bytes, 'sha1') !== artifact.sha1) bytes = null
    if (!bytes) {
      if (offline) throw new Error('verified input JAR not cached')
      const response = await fetch(artifact.url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) throw new Error('input artifact exceeds 2 MiB audit limit')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
      downloadedBytes += bytes.length
      assert.equal(hash(bytes, 'sha1'), artifact.sha1)
      await fs.writeFile(jar, bytes)
    }
    assert.equal(hash(bytes, 'sha1'), artifact.sha1)
    if (artifact.size != null) assert.equal(bytes.length, artifact.size)
    result.bytes = bytes.length
    const classes = []
    for (const [classPath, required] of Object.entries(artifact.family === 'lwjgl2' ? legacy : artifact.family === 'sdl' ? sdl : modern)) {
      const classBytes = await archiveRead(jar, classPath)
      const visitor = new Methods()
      new ClassReader(classBytes).accept(visitor, [], ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES)
      const methods = visitor.methods.filter(method => required.includes(method.name))
      const missing = required.filter(name => !methods.some(method => method.name === name && method.static && !method.native && !method.abstract))
      const optionalNames = ['glfwRawMouseMotionSupported', 'glfwGetWindowContentScale', 'glfwGetPlatform', 'glfwSetWindowContentScaleCallback']
      classes.push({ path: classPath, sha256: hash(classBytes), classMajor: classBytes.readUInt16BE(6), requiredMethods: required, missingJavaHookMethods: missing, hookSurface: methods, hookSignatureSha256: hash(methods.map(method => `${method.name}${method.descriptor}`).sort().join('\n')), optionalMethods: Object.fromEntries(optionalNames.map(name => [name, visitor.methods.some(method => method.name === name)])) })
    }
    result.classes = classes
    result.staticStatus = classes.every(item => !item.missingJavaHookMethods.length) ? 'required-methods-found' : 'adapter-changes-required'
  } catch (error) { result.staticStatus = 'failed'; result.error = String(error) }
  results.push(result)
  console.log(JSON.stringify({ phase: 'input-library-inspection', artifact: artifact.name, status: result.staticStatus }))
}
await writeJson(path.join(output, 'input-hook-inspection.json'), { schemaVersion: 1, observedAt: new Date().toISOString(), parser: '@xmcl/asm@1.0.1 (existing dependency)', downloadedBytes, noGameJarsDownloaded: true, assessment: 'method existence and Java hook surface only; does not establish successful instrumentation, focus behavior, input delivery or rendered frames', artifacts: results })
assert.equal(results.length, artifacts.length)
console.log(JSON.stringify({ total: results.length, matching: results.filter(row => row.staticStatus === 'required-methods-found').length, failed: results.filter(row => row.staticStatus === 'failed').length, downloadedBytes }))
if (results.some(row => row.staticStatus === 'failed')) process.exitCode = 2
