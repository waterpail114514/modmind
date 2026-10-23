import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { driver, type Driver } from 'driver.js'
import { ArrowRight, Blocks, Check, Layers, Server, Sparkles, Sun, X } from 'lucide-react'
import type { ProjectInfo, UiMode } from '../../../shared/types'
import { featurePageApplies } from '../../../shared/featureApplicability'
import { useFeatureStore } from '../useFeatureStore'
import { refreshFeaturePlugins, useFeaturePlugins } from '../featurePlugins'
import { canSelectFeature, featureBundles, featureInstallPlan } from '../featureInstallPlan'
import { onboardingGoals, onboardingRequiredFeatures, onboardingTasks, pendingOnboardingFeatures, resumeOnboarding, type OnboardingSession } from '../onboarding'
import 'driver.js/dist/driver.css'
import './onboarding.css'

const goalIcons = { mod: Blocks, modpack: Layers, server: Server, shader: Sun }
const visible = (selector: string): HTMLElement | undefined => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(element => element.getClientRects().length > 0 && !element.closest('[hidden]'))
const bytes = (value: number): string => value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

interface GuideStep {
  element?: HTMLElement
  title: string
  description: string
  progress: string
  nextLabel?: string
  nextDisabled?: boolean
  next?: () => void
  back?: () => void
}

/** Driver owns positioning, scroll tracking and focus. Application state owns completion. */
function Spotlight({ step, onPause }: { step: GuideStep; onPause: () => void }): null {
  const instance = useRef<Driver>()
  const actions = useRef({ step, onPause })
  actions.current = { step, onPause }
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const tour = driver({
      animate: false, smoothScroll: false, allowClose: true, allowKeyboardControl: false,
      overlayColor: getComputedStyle(document.documentElement).getPropertyValue('--theme-scrim').trim(),
      overlayOpacity: 0.9, overlayClickBehavior: 'none', stagePadding: 7, stageRadius: 9,
      popoverClass: 'modmind-tutorial-popover', popoverOffset: 16,
      onCloseClick: () => actions.current.onPause(),
      onPopoverRender: popover => {
        popover.wrapper.setAttribute('data-onboarding-popover', '')
        popover.wrapper.setAttribute('aria-label', '新手教程')
        const marker = document.createElement('div')
        marker.className = 'onboarding-progress'
        marker.textContent = actions.current.step.progress
        popover.wrapper.prepend(marker)
        popover.closeButton.title = '暂停教程'
        popover.closeButton.setAttribute('aria-label', '暂停教程')
        popover.previousButton.onclick = () => actions.current.step.back?.()
        popover.nextButton.onclick = () => actions.current.step.next?.()
        popover.nextButton.disabled = Boolean(actions.current.step.nextDisabled)
        const pause = document.createElement('button')
        pause.className = 'onboarding-pause'
        pause.textContent = '稍后继续'
        pause.onclick = () => actions.current.onPause()
        popover.footer.prepend(pause)
      }
    })
    instance.current = tour
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); actions.current.onPause() }
      // Prevent shortcuts from operating controls covered by the tutorial.
      if ((event.ctrlKey || event.metaKey) && !['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    let scrollFrame = 0
    const onScroll = (): void => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(() => tour.refresh())
    }
    // Host pages scroll inside panels, whose scroll events do not bubble to window.
    document.addEventListener('scroll', onScroll, true)
    // A drawer's transform can move the target after its first measurement.
    document.addEventListener('transitionend', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('transitionend', onScroll, true)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(scrollFrame)
      tour.destroy(); instance.current = undefined
      if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    // Center inside the actual scroll panel, including space reserved for download status.
    step.element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    instance.current?.highlight({ element: step.element, popover: {
      title: escapeHtml(step.title), description: escapeHtml(step.description),
      side: 'bottom', align: 'center', showButtons: ['close', ...(step.back ? ['previous' as const] : []), ...(step.next ? ['next' as const] : [])],
      nextBtnText: step.nextLabel ?? '继续', prevBtnText: '上一步', closeBtnLabel: '暂停教程',
      onNextClick: () => actions.current.step.next?.(), onPrevClick: () => actions.current.step.back?.()
    } })
  }, [step.element, step.title, step.description, step.progress, step.nextLabel, Boolean(step.next), Boolean(step.back)])
  useEffect(() => {
    // Validity updates must not rebuild the popover or disturb someone typing.
    const next = instance.current?.getState('popover')?.nextButton as HTMLButtonElement | undefined
    if (next) next.disabled = Boolean(step.nextDisabled)
  }, [step.nextDisabled])
  return null
}

function Question({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    dialog.showModal()
    dialog.querySelector<HTMLButtonElement>('.onboarding-choice,.primary-button')?.focus({ preventScroll: true })
    return () => { dialog.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog className="onboarding-question" ref={ref} aria-labelledby="onboarding-question-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><span className="onboarding-badge"><Sparkles size={16} />新手教程</span><button className="icon-button" title="稍后继续" aria-label="关闭教程" onClick={onClose}><X size={18} /></button></header>
    <h2 id="onboarding-question-title">{title}</h2>
    {children}
  </dialog>, document.body)
}

export default function OnboardingGuide({ session, update, view, project, uiMode, showCreate, ready, onNavigate, onRevealNavigation, onCreate, onCloseCreate }: {
  session: OnboardingSession
  update: (patch: Partial<OnboardingSession>) => void
  view: string
  project: ProjectInfo | null
  uiMode: UiMode
  showCreate: boolean
  ready: boolean
  onNavigate: (id: string) => void
  onRevealNavigation: (id: string) => void
  onCreate: () => void
  onCloseCreate: () => void
}): React.JSX.Element | null {
  const store = useFeatureStore(), plugins = useFeaturePlugins()
  const [offerResume, setOfferResume] = useState(session.status === 'paused')
  const [tick, setTick] = useState(0)
  const [retryError, setRetryError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const goal = onboardingGoals.find(value => value.id === session.goal)
  const task = session.goal ? onboardingTasks[session.goal].find(value => value.id === session.task) : undefined
  const running = session.status === 'running'
  const pause = (): void => { setOfferResume(false); update({ status: 'paused' }) }
  const move = (phase: OnboardingSession['phase']): void => update({ phase })
  const bundle = featureBundles.find(value => value.id === goal?.id)
  const required = onboardingRequiredFeatures(session.goal, session.task)
  const pendingIds = pendingOnboardingFeatures(required, store.entries, plugins.catalog, plugins.modules)
  const pendingId = pendingIds[0]
  const entry = store.entries.find(value => value.id === pendingId)
  const hasNativeDialog = Boolean(document.querySelector('dialog:modal:not(.onboarding-question),.interaction-dialog-backdrop'))
  const covered = document.body.hasAttribute('data-loading-covered')
  const fields = Array.from(document.querySelectorAll<HTMLElement>('.studio-create-dialog [data-onboarding-field]')).filter(field => field.getClientRects().length && field.dataset.onboardingReadonly !== 'true')
  const field = fields[session.fieldIndex]
  const control = field?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')
  const selectedOption = field?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
  const editionValid = field?.dataset.onboardingField !== 'edition' || selectedOption?.dataset.onboardingValue === 'java'
  const fieldValid = Boolean(editionValid && field && (control ? !control.disabled && control.checkValidity() && (!control.required || control.value.trim()) : selectedOption))

  useEffect(() => {
    if (!ready || (!running && !offerResume)) return
    // A bounded active-only poll catches native dialogs, dynamic form fields and removed targets.
    const timer = window.setInterval(() => setTick(value => value + 1), 250)
    return () => clearInterval(timer)
  }, [ready, running, offerResume])

  useEffect(() => {
    if (!ready || !running || covered || hasNativeDialog) return
    if (session.phase === 'features' && view === 'features') move('locate')
    if (session.phase === 'create' && showCreate) move('studio')
    if (['studio', 'field', 'submit'].includes(session.phase) && !showCreate) move('create')
    if (session.phase === 'field' && fields.length && !field) move('submit')
    if (session.phase === 'tool' && task && task.view !== 'workspace' && view === task.view && project?.path === session.projectPath) move('complete')
  }, [ready, running, covered, hasNativeDialog, session.phase, view, showCreate, plugins.ready, pendingId, store.entries.length, Boolean(field), fields.length, task?.view, project?.path, session.projectPath])

  useEffect(() => {
    if (ready && running && ['features', 'tool'].includes(session.phase)) onRevealNavigation(session.phase === 'features' ? 'features' : task?.view ?? 'workspace')
  }, [ready, running, session.phase, task?.view])

  const retry = (): void => {
    if (retrying) return
    setRetrying(true); setRetryError('')
    void Promise.all([window.modmind.featurePlugins.refreshStore(), refreshFeaturePlugins()]).catch(error => setRetryError(String(error))).finally(() => setRetrying(false))
  }
  if (!ready || covered || hasNativeDialog) return null
  if (session.status === 'paused' && offerResume) return <Question key="resume" title="继续上次的新手教程？" onClose={() => setOfferResume(false)}>
    <p>{goal ? `上次选择了「${goal.name}」，已安装的工具和项目都会保留。` : '可以接着完成工具准备和项目创建。'}</p>
    <footer><button className="secondary-button" onClick={() => setOfferResume(false)}>稍后继续</button><button className="primary-button" onClick={() => { setOfferResume(false); update(resumeOnboarding(session, project?.path)) }}>继续教程<ArrowRight size={16} /></button></footer>
  </Question>
  if (!running) return null
  if (session.phase === 'experience') return <Question key="experience" title="你用过 ModMind 吗？" onClose={() => update({ status: 'skipped' })}>
    <div className="onboarding-choices"><button className="onboarding-choice featured" onClick={() => move('goal')}><Sparkles size={21} /><span><strong>我是新手，带我开始</strong><span>跟着发光按钮，准备工具并创建第一个项目</span></span><ArrowRight size={18} /></button><button className="onboarding-choice" onClick={() => update({ status: 'skipped' })}><Check size={21} /><span><strong>我是老手，直接进入</strong><span>跳过教程，自由使用</span></span><ArrowRight size={18} /></button></div>
  </Question>
  if (session.phase === 'goal') return <Question key="goal" title="你想做什么项目？" onClose={pause}>
    <div className="onboarding-choices">{onboardingGoals.map(value => { const Icon = goalIcons[value.id]; return <button key={value.id} className="onboarding-choice" onClick={() => update({ goal: value.id, task: undefined, phase: 'task', fieldIndex: 0, projectPath: undefined })}><Icon size={21} /><span><strong>{value.name}</strong><span>{value.example}</span></span><ArrowRight size={18} /></button> })}</div>
    <p className="onboarding-scope">第一版引导 Java 版项目；其他平台可退出教程后自行创建。</p>
    <footer><button className="secondary-button" onClick={() => move('experience')}>上一步</button><button className="onboarding-pause" onClick={pause}>稍后继续</button></footer>
  </Question>
  if (session.phase === 'task' && goal) return <Question key="task" title="你想先完成什么？" onClose={pause}>
    <p>{goal.name} · 先准备整套推荐组合，再开始这项任务</p>
    <div className="onboarding-choices">{onboardingTasks[goal.id].map(value => <button key={value.id} className="onboarding-choice" onClick={() => update({ task: value.id, phase: 'features', fieldIndex: 0, projectPath: undefined })}><Sparkles size={20} /><span><strong>{value.name}</strong></span><ArrowRight size={18} /></button>)}</div>
    <footer><button className="secondary-button" onClick={() => move('goal')}>上一步</button><button className="onboarding-pause" onClick={pause}>稍后继续</button></footer>
  </Question>
  if (!goal || !task) return null
  if (session.phase === 'complete') return <Question key="complete" title="创作准备完成" onClose={() => update({ status: 'done' })}>
    <div className="onboarding-complete-mark"><Check size={26} /></div>
    <p><strong>{project?.name}</strong></p><p>{task.result}</p>
    <p className="onboarding-scope">以后需要更多工具，可以回到「功能」下载。教程可在「更多操作」中重新打开。</p>
    <footer><button className="primary-button" onClick={() => update({ status: 'done' })}>开始创作<ArrowRight size={16} /></button></footer>
  </Question>

  const nav = (id: string, name: string, description: string): GuideStep => {
    const target = visible(`[data-onboarding-nav="${id}"]`)
    const downloads = visible('[data-onboarding-nav="features"]')
    const more = visible('[data-onboarding="more"]')
    const element = target ?? downloads ?? more
    return { element, title: name, description: target ? description : downloads ? '点击「功能与下载」，在那里找到工具入口。' : more ? '点击发光的「更多操作」，再选择「功能与下载」。' : description, progress: id === 'features' ? '准备工具 · 1/3' : '开始创作 · 3/3', ...(!element ? { nextLabel: id === 'features' ? '打开功能页' : '打开工具', next: () => onNavigate(id) } : {}) }
  }
  let step: GuideStep
  if (session.phase === 'features') {
    step = { ...nav('features', '找到工具下载入口', '点击发光的「功能」，这里可以下载各个创作工具。'), back: () => move('task') }
  } else if (session.phase === 'locate' || session.phase === 'install') {
    const progress = '准备工具 · 1/3'
    if (view !== 'features') step = nav('features', '回到功能页', '点击「功能」，继续准备工具。')
    else if (!store.entries.length || !plugins.ready) step = { title: store.error ? '功能目录暂不可用' : '正在读取工具状态', description: retryError || store.error || '教程会检查已有工具，避免重复下载。', progress, nextLabel: retrying ? '正在重试…' : '重新检查', nextDisabled: retrying, next: retry, back: () => move('task') }
    else if (visible('[data-onboarding="feature-batch"]')?.dataset.onboardingRunning === 'true') {
      const batch = visible('[data-onboarding="feature-batch"]')!
      const completed = Number(batch.dataset.onboardingCompleted ?? 0), total = Number(batch.dataset.onboardingTotal ?? 0)
      step = { element: batch, title: '正在准备整套推荐组合', description: `已处理 ${completed} / ${total} 项。${store.job?.phase === 'downloading' ? `${store.job.name}：已下载 ${bytes(store.job.downloaded)}${store.job.total ? ` / ${bytes(store.job.total)}` : ''}。` : '正在校验并载入工具。'}全部可用后才能继续，可以点击「取消剩余」暂停下载。`, progress }
    } else if (store.job && ['downloading', 'installing'].includes(store.job.phase)) {
      const job = store.job
      step = { element: visible('[data-onboarding="feature-job"]'), title: `正在准备${job.name}`, description: job.phase === 'downloading' ? `已下载 ${bytes(job.downloaded)}${job.total ? ` / ${bytes(job.total)}` : ''}。安装完成后会继续检查组合；可以取消下载。` : '正在校验并安装。工具实际可用后，教程才会继续。', progress }
    } else if (pendingId === goal.featureId) {
      const tab = visible('[data-onboarding="studios-tab"]')
      const search = visible('[data-onboarding="feature-search"]') as HTMLInputElement | undefined
      const row = visible(`[data-onboarding-feature="${goal.featureId}"]`)
      const detail = visible(`[data-onboarding-detail="${goal.featureId}"]`)
      if (tab?.getAttribute('aria-selected') !== 'true') step = { element: tab, title: '先准备创作工作台', description: `点击「工作台」，找到${goal.name}需要的工作台。`, progress }
      else if (search?.value && !row) step = { element: search, title: '清除之前的搜索', description: '清空搜索内容，让需要的工具重新出现。', progress }
      else if (!entry) step = { title: '暂时找不到所需工作台', description: retryError || store.error || '工作台尚未发布，可以重新检查或稍后继续。', progress, nextLabel: '重新检查', next: retry, nextDisabled: retrying }
      else if (detail) {
        const action = detail.querySelector<HTMLButtonElement>('[data-onboarding="feature-primary"] button')
        const plan = featureInstallPlan(store.entries, [entry.id])
        const rendererError = plugins.records.find(record => record.id === entry.id)?.error
        if (entry.available && !entry.updateAvailable) step = { element: detail, title: rendererError ? '工具界面没有加载成功' : '正在载入工具界面', description: rendererError || '安装状态已就绪，正在检查界面是否可用。', progress, nextLabel: '重新载入', next: retry, nextDisabled: retrying, back: () => move('task') }
        else if (!action || action.disabled || plan.error) step = { element: detail, title: `${entry.name}暂不可用`, description: entry.incompatible || plan.error || entry.error || store.error || '这个组件尚未发布，或当前版本暂不支持。可以重新检查，或选择其他目标。', progress, nextLabel: retrying ? '正在检查…' : '重新检查', next: retry, nextDisabled: retrying, back: () => move('task') }
        else step = { element: action, title: entry.installed && !entry.enabled ? `启用${entry.name}` : `安装${entry.name}`, description: `点击发光按钮。${plan.bytes ? `本次下载 ${bytes(plan.bytes)}，包含所需依赖。` : '已安装的组件会直接启用。'}接着准备整套推荐组合。`, progress, back: () => move('task') }
      } else if (row) step = { element: row.querySelector<HTMLElement>('.feature-store-select') ?? row, title: `找到${entry.name}`, description: `点击这一项，查看下载大小和安装按钮。${entry.builtin ? '这个工作台随软件内置。' : ''}`, progress, back: () => move('task') }
      else step = { title: '当前列表没有显示所需工具', description: '清除状态筛选和搜索后，再查找所需工具。', element: visible('[data-onboarding="feature-filters"]'), progress, nextLabel: '重新检查', next: retry, back: () => move('task') }
    } else {
      const tab = visible('[data-onboarding="features-tab"]')
      const scope = visible('[data-onboarding="feature-scope"]') as HTMLSelectElement | undefined
      const category = visible('[data-onboarding="recommended-features"]')
      const search = visible('[data-onboarding="feature-search"]') as HTMLInputElement | undefined
      const filter = visible('[data-onboarding-filter="all"]')
      const close = visible('[data-onboarding="close-feature-detail"]')
      const option = visible(`[data-onboarding-bundle-option="${goal.id}"]`)
      const panel = visible(`[data-onboarding-bundle="${goal.id}"]`)
      const select = visible('[data-onboarding="bundle-select"]') as HTMLButtonElement | undefined
      const install = visible('[data-onboarding="bundle-install"]') as HTMLButtonElement | undefined
      const selected = visible('[data-onboarding="feature-batch"]')?.dataset.onboardingPending?.split(',') ?? []
      const selectable = required.filter(id => { const value = store.entries.find(entry => entry.id === id); return value && canSelectFeature(value) })
      const plan = featureInstallPlan(store.entries, required)
      const rendererError = pendingIds.map(id => plugins.records.find(record => record.id === id)?.error).find(Boolean)
      if (tab?.getAttribute('aria-selected') !== 'true') step = { element: tab, title: '找到推荐组合', description: '点击「功能」，准备项目的整套配套工具。', progress }
      else if (scope && scope.value !== 'all') step = { element: scope, title: '查看全部工作台的功能', description: '把范围切换为「全部工作台」，显示这次项目需要的完整组合。', progress }
      else if (category?.getAttribute('aria-pressed') !== 'true') step = { element: category, title: '打开推荐组合', description: '点击「推荐组合」，这里已经为不同项目整理好了配套工具。', progress }
      else if (search?.value) step = { element: search, title: '清除之前的搜索', description: '清空搜索内容，查看完整推荐组合。', progress }
      else if (filter?.getAttribute('aria-pressed') !== 'true') step = { element: filter, title: '查看组合中的全部功能', description: '点击「全部」，同时查看已安装和需要下载的工具。', progress }
      else if (close) step = { element: close, title: '回到推荐组合', description: '关闭单项详情，接下来安装整套工具。', progress }
      else if (option?.getAttribute('aria-pressed') !== 'true' && option) step = { element: option, title: `选择「${bundle?.name ?? goal.name}」组合`, description: '点击与你的项目对应的推荐组合。', progress }
      else if (!option || !bundle) step = { element: category, title: '推荐组合暂不可用', description: retryError || store.error || '暂时找不到完整推荐组合，可以重新检查或稍后继续。', progress, nextLabel: '重新检查', next: retry, nextDisabled: retrying }
      else if (!pendingIds.length) step = { element: panel, title: '整套推荐组合已就绪', description: `${bundle.ids.length} 项推荐功能和对应工作台都已可用。以后也可以在这里下载、更新工具。点击继续，进入${session.projectPath === project?.path && session.projectPath ? '已创建的项目' : '项目创建'}。`, progress, nextLabel: '准备好了，继续', next: () => move(session.projectPath && session.projectPath === project?.path ? 'tool' : 'create'), back: () => move('task') }
      else if (plan.error) step = { element: panel, title: '推荐组合还没有准备完整', description: retryError || `${plan.error}。请检查网络后重新检查，或稍后继续。`, progress, nextLabel: retrying ? '正在检查…' : '重新检查', next: retry, nextDisabled: retrying, back: () => move('task') }
      else if (rendererError || !selectable.length) step = { element: panel, title: rendererError ? '组合中的工具界面加载失败' : '正在载入组合中的工具', description: rendererError || '安装已完成，正在确认整套工具的界面都可用。', progress, nextLabel: '重新载入', next: retry, nextDisabled: retrying, back: () => move('task') }
      else if (!selectable.every(id => selected.includes(id))) step = { element: select, title: '选择整套推荐组合', description: `点击「选择组合」，一次选中全部需要安装、启用或更新的工具。${plan.bytes ? `本次下载 ${bytes(plan.bytes)}，包含依赖。` : '已有组件会直接启用。'}`, progress, back: () => move('task') }
      else if (install && !install.disabled) step = { element: install, title: '下载整套推荐组合', description: `${store.job?.phase === 'error' ? '上次安装未全部完成，点击重试剩余工具。' : store.job?.phase === 'cancelled' ? '上次下载已取消，可以继续准备剩余工具。' : '点击「安装所选」，准备完整推荐组合。'}${plan.bytes ? `本次下载 ${bytes(plan.bytes)}，包含依赖。` : '已有组件会直接启用。'}全部就绪后，再点继续。`, progress, back: () => move('task') }
      else step = { element: panel, title: '等待组合安装入口', description: '正在读取选择和安装状态，可以重新检查后继续。', progress, nextLabel: '重新检查', next: retry, nextDisabled: retrying }
    }
  } else if (session.phase === 'create') {
    const element = visible('[data-onboarding="new-project"]')
    const more = visible('[data-onboarding="more"]')
    step = { element: element ?? more, title: '创建你的第一个项目', description: element ? '需要的工具已经就绪。点击「新建项目」。' : '需要的工具已经就绪。点击「更多操作」，再选择「新建项目」。', progress: '创建项目 · 2/3', ...(!element && !more ? { nextLabel: '新建项目', next: onCreate } : {}), back: () => move('task') }
  } else if (session.phase === 'studio') {
    const element = visible(`[data-onboarding-studio="${goal.studioId}"]`)
    const selected = element?.getAttribute('aria-pressed') === 'true'
    step = { element, title: `选择${goal.name}的工作台`, description: selected ? '工作台已选中，继续填写项目资料。' : '点击发光的项目类型。教程会跟着这个项目继续。', progress: '创建项目 · 2/3', ...(selected ? { next: () => update({ phase: 'field', fieldIndex: 0 }) } : {}), back: () => { onCloseCreate(); move('create') } }
  } else if (session.phase === 'field') {
    const label = field?.querySelector('label')?.textContent ?? '项目资料'
    const name = field?.dataset.onboardingBind === 'name'
    step = { element: field, title: name ? '给项目起个名字' : `选择${label}`, description: name ? '在发光的输入框填写项目名称，然后继续。' : field?.dataset.onboardingField === 'edition' ? '这次教程使用 Java 版。请选择「Java 版」，再继续。' : '选择你使用的版本或平台；不确定时可以保留默认选项，再继续。', progress: `创建项目 · ${Math.min(session.fieldIndex + 1, fields.length)}/${fields.length} 项`, nextLabel: '填好了，继续', nextDisabled: !fieldValid, next: () => update({ fieldIndex: session.fieldIndex + 1 }), back: () => session.fieldIndex ? update({ fieldIndex: session.fieldIndex - 1 }) : move('studio') }
  } else if (session.phase === 'submit') {
    const button = visible('[data-onboarding="create-submit"]') as HTMLButtonElement | undefined
    const error = visible('[data-onboarding="create-error"]')
    step = error ? { element: error, title: '项目还没有创建成功', description: error.textContent ?? '请检查项目资料后重试。', progress: '创建项目 · 2/3', nextLabel: '返回填写', next: () => update({ phase: 'field', fieldIndex: 0 }) } : { element: button, title: button?.disabled ? '正在创建项目' : '保存并创建项目', description: button?.disabled ? '等待创建完成，教程会继续。' : '点击「创建项目」，在系统窗口中选择保存位置。取消选择会回到这里，可以再次尝试。', progress: '创建项目 · 2/3', back: button?.disabled ? undefined : () => update({ phase: 'field', fieldIndex: Math.max(0, fields.length - 1) }) }
  } else {
    const page = Object.values(plugins.modules).flatMap(module => module.pages).find(page => page.id === task.view)
    if (task.view !== 'workspace' && (!page || !featurePageApplies(page, project, uiMode))) step = { title: '这个项目暂不能使用所选工具', description: '可以返回修改目标，或退出教程后选择与工具匹配的项目平台。', progress: '开始创作 · 3/3', nextLabel: '修改目标', next: () => move('task') }
    else if (task.view === 'workspace' && view === 'workspace' && project?.path === session.projectPath) step = { element: visible('.agent-workbench textarea'), title: '在这里描述你的创作想法', description: '先写下想实现的玩法或指令。使用 AI 时，点击窗口上方「连接账号」；准备好后再发送。', progress: '开始创作 · 3/3', nextLabel: '知道了，开始创作', next: () => move('complete') }
    else step = nav(task.view, task.view === 'workspace' ? '进入工作台' : '打开刚准备好的工具', '点击发光入口，进入你的第一项创作任务。')
  }
  // tick deliberately refreshes DOM-derived state; Spotlight only changes on meaningful values.
  void tick
  return <Spotlight step={step} onPause={pause} />
}
