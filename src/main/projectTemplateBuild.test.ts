import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureManagedJdk } from './jdkDownload'
import { buildJavaRangeForProject, javaVersionForMinecraft } from './loaderCompatibility'
import { projectTemplateFiles } from './projectTemplates'
import { managedJavaEnvironment } from './javaEnvironment'
import type { JavaLoaderKind, ProjectInfo } from '../shared/types'

interface MatrixCase {
  loader: JavaLoaderKind
  minecraftVersion: string
  loaderVersion: string
  apiVersion?: string
}

const knownCases: Record<string, MatrixCase> = {
  'fabric-26.3': { loader: 'fabric', minecraftVersion: '26.3', loaderVersion: '0.19.5', apiVersion: '0.164.0+26.3' },
  'forge-26.3': { loader: 'forge', minecraftVersion: '26.3', loaderVersion: '26.3-66.0.13' },
  'neoforge-26.3': { loader: 'neoforge', minecraftVersion: '26.3', loaderVersion: '26.3.0.94' },
  'forge-1.7.10': { loader: 'forge', minecraftVersion: '1.7.10', loaderVersion: '1.7.10-10.13.4.1614-1.7.10' },
  'forge-1.8.9': { loader: 'forge', minecraftVersion: '1.8.9', loaderVersion: '1.8.9-11.15.1.2318-1.8.9' },
  'forge-1.12.2': { loader: 'forge', minecraftVersion: '1.12.2', loaderVersion: '1.12.2-14.23.5.2860' },
  'fabric-1.14.4': { loader: 'fabric', minecraftVersion: '1.14.4', loaderVersion: '0.19.3', apiVersion: '0.28.5+1.14' },
  'fabric-1.17.1': { loader: 'fabric', minecraftVersion: '1.17.1', loaderVersion: '0.19.3', apiVersion: '0.46.1+1.17' },
  'fabric-1.18.2': { loader: 'fabric', minecraftVersion: '1.18.2', loaderVersion: '0.19.3', apiVersion: '0.77.0+1.18.2' },
  'fabric-1.20.1': { loader: 'fabric', minecraftVersion: '1.20.1', loaderVersion: '0.19.3', apiVersion: '0.92.11+1.20.1' },
  'fabric-1.21.11': { loader: 'fabric', minecraftVersion: '1.21.11', loaderVersion: '0.19.3', apiVersion: '0.141.6+1.21.11' },
  'fabric-26.2': { loader: 'fabric', minecraftVersion: '26.2', loaderVersion: '0.19.3', apiVersion: '0.156.0+26.2' }
}

async function writeProject(root: string, project: ProjectInfo): Promise<void> {
  for (const [relative, content] of Object.entries(projectTemplateFiles(project))) {
    const target = path.join(root, ...relative.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  for (const [source, target] of [['gradlew', 'gradlew'], ['gradlew.bat', 'gradlew.bat'], ['gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.jar']]) {
    const output = path.join(root, ...target.split('/'))
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.copyFile(path.join(process.cwd(), 'vendor', 'gradle-wrapper', source), output)
  }
  if (process.platform !== 'win32') await fs.chmod(path.join(root, 'gradlew'), 0o755)
}

async function gradleBuild(root: string, javaHome: string): Promise<string> {
  const command = process.platform === 'win32' ? 'cmd.exe' : path.join(root, 'gradlew')
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'gradlew.bat', 'build', '--no-daemon', '--stacktrace']
    : ['build', '--no-daemon', '--stacktrace']
  return await new Promise<string>((resolve, reject) => {
    let output = ''
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      shell: false,
      env: managedJavaEnvironment({ ...process.env, JAVA_HOME: javaHome, GRADLE_USER_HOME: path.join(os.tmpdir(), 'modmind-real-gradle-cache') })
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Gradle build timed out\n${output.slice(-20_000)}`))
    }, 30 * 60_000)
    const capture = (chunk: Buffer): void => { if (output.length < 4_000_000) output += chunk.toString('utf8') }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`Gradle exited with ${code}\n${output.slice(-30_000)}`))
    })
  })
}

describe('real generated project builds', () => {
  const requested = (process.env.MODMIND_REAL_BUILD_MATRIX ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!requested.length) it.skip('set MODMIND_REAL_BUILD_MATRIX to run network builds', () => undefined)
  for (const id of requested) {
    const value = knownCases[id]
    it(id, async () => {
      expect(value, `Unknown build matrix case: ${id}`).toBeTruthy()
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `modmind-${id}-`))
      try {
        const project: ProjectInfo = {
          name: `Real Build ${id}`, path: root, namespace: `real_${id.replaceAll('.', '_').replaceAll('-', '_')}`,
          createdAt: new Date().toISOString(), javaVersion: javaVersionForMinecraft(value.minecraftVersion), ...value
        }
        await writeProject(root, project)
        const range = buildJavaRangeForProject(project)
        const jdk = await ensureManagedJdk(path.join(os.tmpdir(), 'modmind-real-jdks'), range.minimum)
        await gradleBuild(root, jdk.home)
        const artifacts = await fs.readdir(path.join(root, 'build', 'libs'))
        expect(artifacts.some((name) => name.endsWith('.jar') && !name.includes('sources'))).toBe(true)
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => undefined)
      }
    }, 35 * 60_000)
  }
})
