import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectInfo } from '../shared/types'

/** Keep feedback verbatim outside the specification; never rewrite user-authored requirements. */
export async function captureCreationRequest(project: ProjectInfo, prompt: string): Promise<void> {
  const request = prompt.trim()
  if (!request) throw new Error('开发需求不能为空')
  const root = path.join(project.path, project.toolDataDirectory ?? '.modmind', 'request-evidence')
  await fs.mkdir(root, { recursive: true })
  const hash = createHash('sha256').update(request).digest('hex')
  const evidence = path.join(root, `${hash}.txt`)
  await fs.writeFile(evidence, request, { encoding: 'utf8', flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const target = path.join(project.path, 'docs', 'idea.md')
  // A large or diagnostic first message is evidence, not a feature specification.
  const diagnostic = /(?:^|\n)\s*(?:at [\w.$]+\(|Caused by:|\[\d{2}:\d{2}:\d{2}[^\]]*\]|[\w.$]+(?:Exception|Error):)/m.test(request)
  const body = request.length <= 8_000 && !diagnostic
    ? request
    : `本次输入包含长文本或诊断信息。完整内容：${path.relative(project.path, evidence).replaceAll('\\', '/')}。当前需求请以会话中有效要求为准。`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `# Project idea\n\n${body}\n\n## Project target\n\n- Platform: ${project.loader}\n- Minecraft: ${project.minecraftVersion}\n- Namespace: ${project.namespace}\n`, { encoding: 'utf8', flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
}
