import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ManagedItem } from '../shared/itemEditor'
import type { ProjectInfo } from '../shared/types'
import { projectTemplateFiles } from './projectTemplates'
import { saveManagedItem } from './itemEditorService'

const targets: Record<string, Pick<ProjectInfo, 'loader' | 'minecraftVersion' | 'loaderVersion' | 'apiVersion' | 'qslVersion'>> = {
  'fabric-1.20.1': { loader: 'fabric', minecraftVersion: '1.20.1', loaderVersion: '0.19.3', apiVersion: '0.92.11+1.20.1' },
  'fabric-1.21.1': { loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.19.3', apiVersion: '0.116.15+1.21.1' },
  'quilt-1.20.1': { loader: 'quilt', minecraftVersion: '1.20.1', loaderVersion: '0.27.1', apiVersion: '7.7.0+0.92.2-1.20.1', qslVersion: '6.3.0+1.20.1' },
  'forge-1.20.1': { loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '1.20.1-47.4.0' },
  'neoforge-1.21.1': { loader: 'neoforge', minecraftVersion: '1.21.1', loaderVersion: '21.1.244' }
}

const item: ManagedItem = { id: 'generated_sword', name: '测试剑', englishName: 'Test Sword', kind: 'sword', stackSize: 1,
  durability: 300, texture: 'minecraft:item/iron_sword', tier: 'iron', attackDamage: 3, attackSpeed: -2.4 }

describe('generated item real Gradle builds', () => {
  const requested = (process.env.MODMIND_ITEM_EDITOR_BUILD_TARGET ?? '').split(',').filter(Boolean)
  if (!requested.length) it.skip('set MODMIND_ITEM_EDITOR_BUILD_TARGET for real Gradle verification', () => undefined)
  for (const target of requested) {
    it(target, async () => {
      const matrix = targets[target]
      expect(matrix, `Unknown build target ${target}`).toBeTruthy()
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `modmind-items-${target}-`))
      try {
        const project: ProjectInfo = { kind: 'mod', name: 'Generated Items Test', namespace: 'generated_items_test', path: root,
          createdAt: new Date().toISOString(), ...matrix }
        for (const [relative, content] of Object.entries(projectTemplateFiles(project))) {
          const file = path.join(root, ...relative.split('/'))
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, content)
        }
        for (const [source, destination] of [['gradlew', 'gradlew'], ['gradlew.bat', 'gradlew.bat'], ['gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.jar']]) {
          const file = path.join(root, ...destination.split('/'))
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.copyFile(path.join(process.cwd(), 'vendor/gradle-wrapper', source), file)
        }
        let revision = 0
        for (const next of [item, { ...item, id: 'generated_pickaxe', kind: 'pickaxe' as const },
          { ...item, id: 'generated_helmet', kind: 'armor' as const, armorSlot: 'helmet' as const, armorMaterial: 'iron' as const }]) {
          revision = (await saveManagedItem(project, { revision, item: next })).revision
        }
        const command = process.platform === 'win32' ? 'cmd.exe' : path.join(root, 'gradlew')
        const tasks = ['build', '--no-daemon', ...(process.env.MODMIND_ITEM_EDITOR_BUILD_OFFLINE ? ['--offline'] : [])]
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'gradlew.bat', ...tasks] : tasks
        const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, JAVA_HOME: process.env.MODMIND_ITEM_EDITOR_JAVA_HOME ?? process.env.JAVA_HOME } })
          let output = ''
          child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
          child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
          child.on('error', reject)
          child.on('exit', code => resolve({ code, output }))
        })
        expect(result.code, result.output.slice(-12000)).toBe(0)
      } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }) }
    }, 15 * 60_000)
  }
})
