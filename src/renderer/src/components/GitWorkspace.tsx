import { reportClientFailure } from '../lib/clientFailure'
import { useEffect, useState } from 'react'
import {
  Check,
  CircleAlert,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Link,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { GitRemote, GitStatus } from '../../../shared/production'
import type { ProjectInfo } from '../../../shared/types'
import { useConfirmDialog } from './InteractionDialogs'

function errorMessage(error: unknown): string {
  return reportClientFailure(error)
}

function changeLabel(index: string, worktree: string): string {
  const state = `${index}${worktree}`
  if (state.includes('?')) return '未跟踪'
  if (state.includes('A')) return '新增'
  if (state.includes('D')) return '删除'
  if (state.includes('R')) return '重命名'
  if (state.includes('U')) return '冲突'
  return '修改'
}

export default function GitWorkspace({ project, onFilesChanged }: { project: ProjectInfo; onFilesChanged: () => void }): React.JSX.Element {
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirmDialog()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState('')
  const [diffPath, setDiffPath] = useState('')
  const [message, setMessage] = useState('')
  const [branchName, setBranchName] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [selectedRemote, setSelectedRemote] = useState('origin')
  const [remoteName, setRemoteName] = useState('origin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [integrationBranch, setIntegrationBranch] = useState('')
  const [busy, setBusy] = useState('status')
  const [notice, setNotice] = useState('')

  const refresh = async (): Promise<void> => {
    setBusy('status')
    try {
      const next = await window.modmind.production.git.status()
      setStatus(next)
      setRemotes(next.initialized ? await window.modmind.production.git.listRemotes() : [])
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    setStatus(null)
    setDiff('')
    setDiffPath('')
    void refresh()
  }, [project.path])

  const initialize = async (): Promise<void> => {
    setBusy('initialize')
    setNotice('')
    try {
      setStatus(await window.modmind.production.git.initialize())
      onFilesChanged()
      setNotice('Git 仓库已初始化，并已补全项目忽略规则')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const showDiff = async (path?: string): Promise<void> => {
    setBusy(`diff:${path ?? '*'}`)
    setNotice('')
    try {
      setDiff(await window.modmind.production.git.diff(path))
      setDiffPath(path ?? '')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const commit = async (): Promise<void> => {
    if (!message.trim()) return
    setBusy('commit')
    setNotice('')
    try {
      setStatus(await window.modmind.production.git.commit({ message, authorName, authorEmail }))
      setMessage('')
      setDiff('')
      setNotice('提交已创建')
      onFilesChanged()
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const createBranch = async (): Promise<void> => {
    if (!branchName.trim()) return
    setBusy('branch')
    setNotice('')
    try {
      setStatus(await window.modmind.production.git.createBranch(branchName))
      setBranchName('')
      setNotice('新分支已创建并切换')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const addRemote = async (): Promise<void> => {
    if (!remoteName.trim() || !remoteUrl.trim()) return
    setBusy('remote-add')
    setNotice('')
    try {
      const next = await window.modmind.production.git.addRemote(remoteName, remoteUrl)
      setRemotes(next)
      setSelectedRemote(remoteName.trim())
      setRemoteUrl('')
      setNotice('远程仓库已添加')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const removeRemote = async (): Promise<void> => {
    if (!selectedRemote || !await requestConfirm({ title: `移除远程仓库“${selectedRemote}”？`, message: '本地代码不会被删除，但后续同步将不再使用这个远程地址', confirmLabel: '移除远程', tone: 'danger' })) return
    setBusy('remote-remove')
    setNotice('')
    try {
      const next = await window.modmind.production.git.removeRemote(selectedRemote)
      setRemotes(next)
      setSelectedRemote(next[0]?.name ?? 'origin')
      setNotice('远程仓库已移除')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const syncRemote = async (action: 'fetch' | 'pull' | 'push'): Promise<void> => {
    if (!selectedRemote || !status) return
    setBusy(action)
    setNotice('')
    try {
      const next = action === 'fetch'
        ? await window.modmind.production.git.fetch(selectedRemote)
        : action === 'pull'
          ? await window.modmind.production.git.pull(selectedRemote, status.branch)
          : await window.modmind.production.git.push(selectedRemote, status.branch)
      setStatus(next)
      onFilesChanged()
      setNotice(action === 'fetch' ? '远程状态已获取' : action === 'pull' ? '已完成仅快进拉取' : '当前分支已推送')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const integrate = async (mode: 'merge' | 'rebase'): Promise<void> => {
    if (!integrationBranch.trim()) return
    setBusy(mode)
    setNotice('')
    try {
      setStatus(mode === 'merge'
        ? await window.modmind.production.git.merge(integrationBranch)
        : await window.modmind.production.git.rebase(integrationBranch))
      setNotice(mode === 'merge' ? '分支已合并' : '分支变基已完成')
      onFilesChanged()
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  const openPullRequest = async (): Promise<void> => {
    setBusy('pr')
    setNotice('')
    try {
      await window.modmind.production.git.pullRequestUrl(selectedRemote)
      setNotice('已在浏览器中打开 GitHub PR 页面')
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  return <section className="git-workspace">
    <div className="section-title-row">
      <div className="git-heading"><GitBranch size={16} /><h2>Git 工作流</h2></div>
      <button className="icon-button" title="刷新 Git 状态" disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === 'status' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
    </div>
    {status && !status.available ? <div className="git-empty"><CircleAlert size={18} /><div><strong>未检测到 Git</strong><p>安装 Git 后即可使用本地提交和分支管理</p></div></div> : null}
    {status?.available && !status.initialized ? <div className="git-empty"><GitBranch size={18} /><div><strong>当前项目还不是 Git 仓库</strong></div><button className="primary-button" disabled={Boolean(busy)} onClick={() => void initialize()}>{busy === 'initialize' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}初始化</button></div> : null}
    {status?.initialized ? <>
      <div className="git-status-line">
        <span><GitBranch size={14} /><strong>{status.branch || 'HEAD'}</strong></span>
        <span>{status.ahead ? `领先 ${status.ahead}` : '无待推送提交'}</span>
        <span>{status.behind ? `落后 ${status.behind}` : '远端已同步'}</span>
        <span>{status.changes.length} 个变更</span>
      </div>
      <div className="git-remote-panel">
        <div className="git-remote-current">
          <select value={selectedRemote} disabled={!remotes.length || Boolean(busy)} onChange={(event) => setSelectedRemote(event.target.value)}>
            {remotes.length ? remotes.map((remote) => <option key={remote.name} value={remote.name}>{remote.name} · {remote.url}</option>) : <option value="origin">尚未配置远程仓库</option>}
          </select>
          <button className="secondary-button compact" disabled={!remotes.length || Boolean(busy)} onClick={() => void syncRemote('fetch')}>{busy === 'fetch' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}获取</button>
          <button className="secondary-button compact" disabled={!remotes.length || Boolean(busy)} onClick={() => void syncRemote('pull')}>{busy === 'pull' ? <LoaderCircle className="spin" size={14} /> : <CloudDownload size={14} />}拉取</button>
          <button className="secondary-button compact" disabled={!remotes.length || Boolean(busy)} onClick={() => void syncRemote('push')}>{busy === 'push' ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}推送</button>
          <button className="icon-button" title="移除远程仓库" disabled={!remotes.length || Boolean(busy)} onClick={() => void removeRemote()}><Trash2 size={14} /></button>
        </div>
        <div className="git-remote-add">
          <Link size={14} />
          <input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} placeholder="origin" />
          <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addRemote() }} placeholder="https://github.com/owner/repository.git" />
          <button className="secondary-button compact" disabled={!remoteName.trim() || !remoteUrl.trim() || Boolean(busy)} onClick={() => void addRemote()}>{busy === 'remote-add' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}添加</button>
        </div>
      </div>
      <div className="git-layout">
        <div className="git-changes">
          <div className="git-subhead"><strong>工作区变更</strong><button disabled={Boolean(busy)} onClick={() => void showDiff()}>查看全部差异</button></div>
          {status.changes.length ? status.changes.map((change) => <button className={diffPath === change.path ? 'selected' : ''} key={`${change.index}${change.worktree}-${change.path}`} onClick={() => void showDiff(change.path)}>
            <span className="git-change-state">{changeLabel(change.index, change.worktree)}</span><code>{change.path}</code>
          </button>) : <div className="inline-empty"><Check size={15} />工作区没有未提交变更</div>}
        </div>
        <div className="git-diff">
          <div className="git-subhead"><strong>{diffPath || '差异预览'}</strong><span>{diff ? `${diff.split('\n').length} 行` : ''}</span></div>
          <pre>{diff || '选择变更文件查看工作区与暂存区差异'}</pre>
        </div>
      </div>
      <div className="git-actions">
        <div className="git-commit-form">
          <input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void commit() }} placeholder="提交说明" maxLength={200} />
          <details><summary>本地提交身份</summary><div><input value={authorName} onChange={(event) => setAuthorName(event.target.value)} placeholder="姓名（可选）" /><input type="email" value={authorEmail} onChange={(event) => setAuthorEmail(event.target.value)} placeholder="邮箱（可选）" /></div></details>
          <button className="primary-button" disabled={!message.trim() || !status.changes.length || Boolean(busy)} onClick={() => void commit()}>{busy === 'commit' ? <LoaderCircle className="spin" size={15} /> : <GitCommitHorizontal size={15} />}提交全部</button>
        </div>
        <div className="git-branch-form"><input value={branchName} onChange={(event) => setBranchName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createBranch() }} placeholder="新分支名称" /><button className="secondary-button" disabled={!branchName.trim() || Boolean(busy)} onClick={() => void createBranch()}>{busy === 'branch' ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}创建并切换</button></div>
        <div className="git-integration-form">
          <input value={integrationBranch} onChange={(event) => setIntegrationBranch(event.target.value)} placeholder="待合并或变基的分支" />
          <button className="secondary-button" disabled={!integrationBranch.trim() || Boolean(busy)} onClick={() => void integrate('merge')}>{busy === 'merge' ? <LoaderCircle className="spin" size={15} /> : <GitMerge size={15} />}合并</button>
          <button className="secondary-button" disabled={!integrationBranch.trim() || Boolean(busy)} onClick={() => void integrate('rebase')}>{busy === 'rebase' ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}变基</button>
          <button className="secondary-button" disabled={!remotes.length || Boolean(busy)} onClick={() => void openPullRequest()}>{busy === 'pr' ? <LoaderCircle className="spin" size={15} /> : <GitPullRequest size={15} />}创建 PR</button>
        </div>
      </div>
    </> : null}
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    {confirmDialog}
  </section>
}
