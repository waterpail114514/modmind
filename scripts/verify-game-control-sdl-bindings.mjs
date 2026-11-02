import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { Version } from '@xmcl/core'

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const resources = path.resolve(arg('resources') || 'D:/Codex/UserData/worktrees/modmind-1-4-14/modmind/test-results/game-control-matrix-resources')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-sdl-binding-'))
const java = path.resolve(process.env.APPDATA, '.minecraft/runtime/java-runtime-epsilon/bin/java.exe')
const jar = path.resolve(arg('jar') || 'test-results/game-control-build/game-control-candidate.jar')
try {
  const profile = await Version.parse(resources, '26.3')
  const classpath = [directory, ...profile.libraries.map(lib => path.join(resources, 'libraries', lib.path))].join(path.delimiter)
  await fs.writeFile(path.join(directory, 'BindingFixture.java'), `
import java.lang.reflect.*;
import java.nio.*;
public class BindingFixture {
  public static void main(String[] args) throws Exception {
    Class<?> events = Class.forName("org.lwjgl.sdl.SDLEvents"), event = Class.forName("org.lwjgl.sdl.SDL_Event");
    Class<?> keyboard = Class.forName("org.lwjgl.sdl.SDLKeyboard"), mouse = Class.forName("org.lwjgl.sdl.SDLMouse"), video = Class.forName("org.lwjgl.sdl.SDLVideo");
    Class<?> adapter = Class.forName("dev.modmind.gamecontrol.SdlInput", true, null);
    Object output = event.getConstructor(ByteBuffer.class).newInstance(ByteBuffer.allocateDirect(event.getField("SIZEOF").getInt(null)));
    events.getMethod("SDL_PollEvent", event).invoke(null, output);
    adapter.getMethod("key", int.class, boolean.class).invoke(null, 87, true);
    adapter.getMethod("key", int.class, boolean.class).invoke(null, 341, true);
    ByteBuffer keys = (ByteBuffer) keyboard.getMethod("SDL_GetKeyboardState").invoke(null);
    if(keys.get(26)!=1 || keys.get(224)!=1 || keys.get(225)!=0) throw new AssertionError("SDL key/scancode substitution");
    if(((Short)keyboard.getMethod("SDL_GetModState").invoke(null)).shortValue()!=64) throw new AssertionError("SDL modifier substitution");
    if(!((Boolean)mouse.getMethod("SDL_SetWindowRelativeMouseMode", long.class,boolean.class).invoke(null,0L,true))) throw new AssertionError("virtual grab");
    if(!((Boolean)events.getMethod("SDL_PollEvent", event).invoke(null, output))) throw new AssertionError("SDL event delivery");
    if(((Integer)event.getMethod("type").invoke(output)).intValue()!=768) throw new AssertionError("SDL event type");
    System.out.println("SDL_BINDINGS_VERIFIED");
  }
}`)
  execFileSync('javac', ['--release', '8', '-encoding', 'UTF-8', '-d', directory, path.join(directory, 'BindingFixture.java')], { windowsHide: true, stdio: 'pipe' })
  const config = path.join(directory, 'session.properties'); await fs.writeFile(config, `sessionId=${randomUUID()}\n`)
  const child = spawn(java, [`-javaagent:${jar}`, '--enable-native-access=ALL-UNNAMED', '-cp', classpath, 'BindingFixture'], { cwd: directory, windowsHide: true, env: { ...process.env, MODMIND_GAME_CONTROL_TOKEN: randomBytes(32).toString('hex'), MODMIND_GAME_CONTROL_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => child.kill(), 30000)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }); clearTimeout(timer)
  await fs.writeFile('test-results/game-control-sdl-bindings.log', output)
  if (code !== 0 || !output.includes('SDL_BINDINGS_VERIFIED') || output.includes('[ModMind game control]')) throw new Error(output.slice(-8000))
  console.log('Real LWJGL SDL 3.4.3 class verification, virtual scan codes/modifiers/event queue passed; no window created')
} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }) }
