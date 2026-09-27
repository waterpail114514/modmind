import { useState } from 'react'
import { Check, CircleAlert, LoaderCircle, Play, X } from 'lucide-react'
import type { TestMatrixResult, TestTarget } from '../../../shared/production'
import { reportClientFailure as errorMessage } from '../lib/clientFailure'

const testTargets: Array<{ id: TestTarget; label: string; detail: string }> = [
  { id: 'build', label: 'Gradle 构建', detail: '编译、资源处理与产物检查' },
  { id: 'client', label: '客户端启动', detail: '启动并稳定运行 20 秒' },
  { id: 'server', label: '专用服务器', detail: '启动并稳定运行 15 秒' },
  { id: 'gametest', label: 'GameTest', detail: '执行 Loader 提供的测试任务' }
]

export default function AutomatedTestsPane(): React.JSX.Element {
  const [targets, setTargets] = useState<TestTarget[]>(['build', 'client', 'server', 'gametest'])
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<TestMatrixResult | null>(null)
  const [notice, setNotice] = useState('')

  const toggle = (target: TestTarget): void => setTargets((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target])

  const run = async (): Promise<void> => {
    if (!targets.length || busy) return
    setBusy('matrix')
    setResult(null)
    setNotice('')
    try {
      setResult(await window.modmind.production.tests.runMatrix(targets))
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy('')
    }
  }

  return <div className="production-pane tests-pane">
    <div className="production-toolbar">
      <div><h2>自动检查</h2></div>
    </div>
    <div className="test-targets">{testTargets.map((target) => <label key={target.id} className={targets.includes(target.id) ? 'selected' : ''}>
      <input type="checkbox" checked={targets.includes(target.id)} onChange={() => toggle(target.id)} />
      <span><strong>{target.label}</strong><small>{target.detail}</small></span>
    </label>)}</div>
    <button className="primary-button matrix-run" disabled={!targets.length || Boolean(busy)} onClick={() => void run()}>{busy === 'matrix' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}运行选中测试</button>
    {notice ? <div className="production-notice"><CircleAlert size={14} /><span>{notice}</span></div> : null}
    {result ? <div className="matrix-results">{result.results.map((entry) => <div className={`matrix-result ${entry.status}`} key={entry.target}>
      <span>{entry.status === 'passed' ? <Check size={15} /> : entry.status === 'failed' ? <X size={15} /> : <CircleAlert size={15} />}</span>
      <div><strong>{testTargets.find((item) => item.id === entry.target)?.label ?? entry.target}</strong><p>{entry.summary}</p></div>
      <time>{(entry.durationMs / 1000).toFixed(1)}s</time>
    </div>)}</div> : null}
  </div>
}

