import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseStatus } from "../../feature-plugins/versions/src/main/gitService"
import { GitService } from "../../feature-plugins/versions/src/main/gitService"

describe('Git status parsing', () => {
  it('parses branches, divergence, and changed paths', () => {
    const result = parseStatus('## main...origin/main [ahead 2, behind 1]\n M src/Main.java\nA  README.md\n')
    expect(result).toMatchObject({ initialized: true, branch: 'main', ahead: 2, behind: 1 })
    expect(result.changes).toEqual([
      { index: ' ', worktree: 'M', path: 'src/Main.java' },
      { index: 'A', worktree: ' ', path: 'README.md' }
    ])
  })

  it('shows text content for an untracked file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-git-'))
    try {
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => execFile('git', ['init', '-b', 'main'], { cwd: root }, (error) => error ? reject(error) : resolve()))
      await fs.writeFile(path.join(root, 'new-file.txt'), 'first\nsecond\n', 'utf8')
      const service = new GitService(() => ({ name: 'Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'test', createdAt: '' }))
      await expect(service.diff('new-file.txt')).resolves.toContain('+first')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('adds, lists, and removes validated remote repositories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modmind-git-remote-'))
    try {
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => execFile('git', ['init', '-b', 'main'], { cwd: root }, (error) => error ? reject(error) : resolve()))
      const service = new GitService(() => ({ name: 'Test', path: root, loader: 'fabric', minecraftVersion: '1.21.1', namespace: 'test', createdAt: '' }))
      await expect(service.addRemote('origin', 'https://github.com/example/mod.git')).resolves.toEqual([
        { name: 'origin', url: 'https://github.com/example/mod.git' }
      ])
      await expect(service.pullRequestUrl('origin')).resolves.toBe('https://github.com/example/mod/compare/main?expand=1')
      await expect(service.addRemote('unsafe', 'file:///tmp/repository')).rejects.toThrow(/HTTPS|SSH/)
      await expect(service.removeRemote('origin')).resolves.toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
