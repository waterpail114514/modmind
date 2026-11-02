import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Blocks, Check, ChevronRight, Layers, Server, Sun } from 'lucide-react'
import type { BeginnerAiPreferences, DeviceConnectionState, ExistingProjectAnalysis, ProjectInfo } from '../../../shared/types'
import { onboardingGoals, onboardingTasks, type OnboardingIntroStep, type OnboardingSession } from '../onboarding'
import { mokoGoalReplies, mokoIntroLine, type MokoLine, type MokoPose } from '../mokoDialogue'
import { MokoAccountPanel, MokoExistingPanel, MokoProjectPanel, MokoToolsPanel } from './MokoSetupPanels'
import MokoModelPanel from './MokoModelPanel'
import './moko-onboarding.css'

const goalIcons = { mod: Blocks, modpack: Layers, server: Server, shader: Sun }
const poses: MokoPose[] = ['welcome', 'think', 'happy']
const chapters = ['初次见面', '创作方向', '准备工具', '配置项目']

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = (): void => setReduce(query.matches)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return reduce
}

/** Only scripted dialogue cues move the actor; ordinary renders leave it still. */
function MokoActor({ pose, motion, cue, reduced }: { pose: MokoPose; motion: MokoLine['motion']; cue: string; reduced: boolean }): React.JSX.Element {
  const actor = useRef<HTMLDivElement>(null), animation = useRef<Animation>()
  useLayoutEffect(() => {
    const element = actor.current
    if (!element) return
    const moving = animation.current?.playState === 'running'
    const style = getComputedStyle(element), from = style.transform
    const easing = style.getPropertyValue('--moko-ease-move').trim()
    animation.current?.cancel()
    animation.current = undefined
    if (reduced || !motion && !moving) return
    // Retarget from the current position if the user advances before landing.
    animation.current = element.animate(motion === 'hop' ? [
      { transform: from, offset: 0 },
      { transform: 'translateY(-4px)', offset: 0.45 },
      { transform: 'translateY(0)', offset: 1 }
    ] : [{ transform: from }, { transform: 'translateY(0)' }], { duration: motion ? 420 : 160, easing })
  }, [cue, motion, reduced])
  useLayoutEffect(() => () => animation.current?.cancel(), [])
  return <div ref={actor} className="moko-actor" aria-hidden="true">{poses.map(value => <span key={value} className={`moko-portrait moko-portrait-${value}${pose === value ? ' active' : ''}`} />)}</div>
}

function useDialogue(text: string, cue: string, reduced: boolean) {
  const [revealed, setRevealed] = useState({ cue: '', text: '', count: 0 })
  const interval = useRef<number>()
  const letters = Array.from(text)
  const count = revealed.cue === cue && revealed.text === text ? revealed.count : 0
  const done = reduced || count >= letters.length
  useEffect(() => {
    if (reduced) return
    let cursor = 0
    setRevealed({ cue, text, count: 0 })
    interval.current = window.setInterval(() => {
      cursor += 1
      setRevealed({ cue, text, count: cursor })
      if (cursor >= letters.length) clearInterval(interval.current)
    }, 28)
    return () => clearInterval(interval.current)
  }, [cue, text, reduced])
  return { done, visible: done ? text : letters.slice(0, count).join(''), finish: () => { clearInterval(interval.current); setRevealed({ cue, text, count: letters.length }) } }
}

export interface MokoOnboardingProps {
  session: OnboardingSession
  update: (patch: Partial<OnboardingSession>) => void
  account: DeviceConnectionState
  onAccountChange: (state: DeviceConnectionState) => void
  onModelApplied: (preferences: BeginnerAiPreferences) => void
  onPause: () => void
  onCreated: (project: ProjectInfo) => void
  onFinish: () => Promise<void>
  onExperienced: () => void
  existingAnalysis: ExistingProjectAnalysis | null
  existingProject: ProjectInfo | null
  onInspected: (analysis: ExistingProjectAnalysis) => void
  onSelectedProject: (project: ProjectInfo) => void
  project?: ProjectInfo | null
  resume?: boolean
  onResume?: () => void
}

export default function MokoOnboarding({ session, update, account, onAccountChange, onModelApplied, onPause, onCreated, onFinish, onExperienced, existingAnalysis, existingProject, onInspected, onSelectedProject, project, resume = false, onResume }: MokoOnboardingProps): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null), options = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [selectedGoal, setSelectedGoal] = useState(session.goal), [selectedTask, setSelectedTask] = useState(session.task)
  const [toolsBusy, setToolsBusy] = useState(false), [creating, setCreating] = useState(false)
  const [modelNotice, setModelNotice] = useState<MokoLine | null>(null)
  const [handoffError, setHandoffError] = useState(''), [handoffAttempt, setHandoffAttempt] = useState(0)
  const starting = useRef(false), finishRef = useRef(onFinish)
  finishRef.current = onFinish
  const step = session.introStep ?? 'hello', phase = session.phase
  const toolRound = ['features', 'locate', 'install'].includes(phase)
  const projectRound = ['create', 'studio', 'field', 'submit'].includes(phase)
  const complete = phase === 'tool' || phase === 'complete'
  const chapter = phase === 'experience' ? 0 : phase === 'goal' || phase === 'task' || phase === 'import' ? 1 : toolRound ? 2 : 3
  const chapterNames = session.projectMode === 'existing' ? ['初次见面', '选择项目', '准备工具', '确认配置'] : chapters
  const intro = (introStep: OnboardingIntroStep): void => { setModelNotice(null); update({ introStep }) }
  const line: MokoLine = resume ? { text: '上次的进度还在。\n要接着往下走吗？', pose: 'welcome' }
    : phase === 'experience' ? step === 'model' && modelNotice ? modelNotice : mokoIntroLine(step, account, session.modelChoice)
    : phase === 'handoff' ? { text: '等我一下……', pose: 'think' }
    : phase === 'goal' ? { text: selectedGoal ? mokoGoalReplies[selectedGoal] : '挑一个感兴趣的方向吧，我们从一件小作品开始。', pose: selectedGoal ? 'welcome' : 'think' }
    : phase === 'task' ? { text: '先挑一件想做的事吧。\n我会陪你准备好工具，再创建项目。', pose: 'welcome' }
    : phase === 'import' ? { text: '把项目文件夹或压缩包交给我吧。\n我先看看里面有什么，再陪你接着做。', pose: 'think' }
    : toolRound ? { text: '这几样工具就够我们开始了。\n已经准备好的会直接复用。', pose: 'think' }
    : projectRound ? { text: session.projectMode === 'existing' ? existingProject ? '工具都准备好了。\n把项目打开，我们就能接着修改啦。' : '项目里的配置我已经带过来了。\n我们确认一下，就可以接着修改啦。' : session.fieldIndex === 0 ? '先给我们的作品起个名字吧。' : session.fieldIndex === 1 ? '选一下它要运行的环境吧。\n不确定的话，可以先用默认选项。' : '再确认一下这一项。\n配置好以后，我们就可以创建项目啦。', pose: 'welcome' }
    : session.projectMode === 'existing' ? { text: `「${project?.name ?? '你的项目'}」已经准备好了。\n我们可以接着修改啦。`, pose: 'happy' }
    : { text: `「${project?.name ?? '你的项目'}」已经创建好了。\n接下来，带你认识灵感台和工作台。`, pose: 'happy', motion: 'hop' }
  const round = resume ? 'resume' : `${phase}:${step}`
  const cue = `${round}:${phase === 'goal' ? selectedGoal ?? '' : ''}:${phase === 'experience' ? `${account.status}:${account.username ?? ''}:${account.provider ?? ''}` : ''}:${projectRound ? session.fieldIndex : ''}`
  const dialogue = useDialogue(line.text, cue, reduced)
  const pureDialogue = !resume && (complete || phase === 'handoff' || phase === 'experience' && !['experience', 'model', 'invitation'].includes(step) && (step !== 'account' || account.status === 'connected'))
  let next: (() => void) | undefined, back: (() => void) | undefined
  if (phase === 'experience') {
    if (step === 'hello') next = () => intro('experience')
    if (step === 'experience') back = () => intro('hello')
    if (step === 'new' || step === 'returning') { next = () => intro('checking'); back = () => intro('experience') }
    if (step === 'account' && account.status === 'connected') next = () => intro(account.provider === 'custom' ? 'invitation' : 'helper')
    if (step === 'helper') { next = () => intro('helpers'); back = () => intro('account') }
    if (step === 'helpers') { next = () => intro('model'); back = () => intro('helper') }
    if (step === 'model') back = () => intro('helpers')
    if (step === 'modelReply') { next = () => intro('invitation'); back = () => intro('model') }
    if (step === 'invitation') back = () => intro(account.status === 'connected' && account.provider !== 'custom' ? 'model' : 'experience')
  } else if (phase === 'goal' || phase === 'import') back = () => update({ phase: 'experience', introStep: 'invitation' })
  else if (phase === 'task') back = () => update({ phase: 'goal' })
  else if (toolRound) back = () => update({ phase: session.projectMode === 'existing' ? 'import' : 'task' })
  else if (projectRound) back = () => update({ phase: 'features' })
  if (complete) next = () => update({ phase: 'handoff' })

  useLayoutEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null
    const background = Array.from(document.querySelectorAll<HTMLElement>('.app-body'))
    const inertValues = background.map(value => value.inert)
    background.forEach(value => { value.inert = true })
    element?.show(); element?.focus({ preventScroll: true })
    const blockShortcuts = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    document.addEventListener('keydown', blockShortcuts, true)
    return () => {
      document.removeEventListener('keydown', blockShortcuts, true)
      element?.close()
      background.forEach((value, index) => { value.inert = inertValues[index] })
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  // Settle focus and scroll before painting a new round; typing never changes option layout.
  useLayoutEffect(() => { if (options.current) options.current.scrollTop = 0; dialog.current?.focus({ preventScroll: true }) }, [round])
  useEffect(() => {
    if (resume || phase !== 'experience' || step !== 'checking' || !dialogue.done) return
    const timer = window.setTimeout(() => intro('account'), reduced ? 0 : 500)
    return () => clearTimeout(timer)
  }, [resume, phase, step, dialogue.done, reduced])
  useEffect(() => {
    if (resume || phase !== 'handoff' || !dialogue.done || starting.current) return
    let active = true
    const timer = window.setTimeout(() => {
      starting.current = true; setCreating(true); setHandoffError('')
      void finishRef.current().catch(reason => {
        if (active) { setHandoffError(reason instanceof Error ? reason.message : '灵感台暂时没准备好，再试一次吧。'); setCreating(false); starting.current = false }
      })
    }, 500)
    return () => { active = false; clearTimeout(timer) }
  }, [resume, phase, dialogue.done, handoffAttempt])
  const advance = (): void => { if (!dialogue.done) dialogue.finish(); else if (pureDialogue) next?.() }
  return createPortal(<dialog ref={dialog} className="moko-onboarding" aria-label="茉可的新手教程" aria-modal="true" tabIndex={-1} data-moko-phase={phase} data-moko-step={step} data-moko-pure={pureDialogue}
    onClick={event => {
      if ((event.target as Element).closest('button,a,input,select,textarea,label,summary,[role="button"]') || window.getSelection()?.toString()) return
      advance()
    }}
    onCancel={event => { event.preventDefault(); if (!creating) onPause() }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!creating) onPause() }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'))
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target === dialog.current) { event.preventDefault(); advance() }
    }}>
    <header className="moko-header"><ol className="moko-chapters" aria-label="教程进度">{chapterNames.map((name, index) => <li key={name} aria-current={chapter === index ? 'step' : undefined} className={index < chapter ? 'passed' : ''}><span>{index < chapter ? <Check size={13} /> : index + 1}</span><span>{name}</span></li>)}</ol></header>
    <main className="moko-stage">
      <div className="moko-stage-actor"><MokoActor pose={line.pose} motion={line.motion} cue={resume ? 'resume' : complete ? 'complete' : round} reduced={reduced} /></div>
      <div className="moko-options" ref={options} data-moko-round={round}>
        {resume ? <section className="moko-choice-panel"><h2>继续上次的教程</h2><div className="moko-panel-actions"><button className="primary-button" onClick={onResume}>继续教程<ArrowRight size={17} /></button><button className="moko-text-button" onClick={onPause}>稍后继续</button></div></section> : <>
          {phase === 'experience' && step === 'experience' ? <div className="moko-choice-panel"><div className="moko-experience-choices"><button className="moko-choice" onClick={() => update({ experience: 'new', introStep: 'new' })}><span>是呀，第一次来</span><ChevronRight size={19} /></button><button className="moko-choice" onClick={onExperienced}><span>以前用过啦</span><ChevronRight size={19} /></button></div></div> : null}
          {phase === 'experience' && step === 'account' && account.status !== 'connected' ? <MokoAccountPanel account={account} onAccountChange={onAccountChange} onSkip={() => intro('invitation')} /> : null}
          {phase === 'experience' && step === 'model' ? <MokoModelPanel account={account} onAccountChange={onAccountChange} onApplied={onModelApplied} onSelected={choice => { setModelNotice(null); update({ introStep: 'modelReply', modelChoice: choice }) }} onNarrative={setModelNotice} onBusyChange={setCreating} /> : null}
          {phase === 'experience' && step === 'invitation' ? <section className="moko-choice-panel" aria-label="开始方式"><button className="moko-choice" onClick={() => { setSelectedGoal(undefined); setSelectedTask(undefined); update({ projectMode: 'new', phase: 'goal', goal: undefined, task: undefined, fieldIndex: 0, projectPath: undefined, importSourcePath: undefined, projectDraft: undefined }) }}><span>从零开始做一个项目</span><ChevronRight size={19} /></button><button className="moko-choice" onClick={() => update({ projectMode: 'existing', phase: 'import', goal: undefined, task: undefined, fieldIndex: 0, projectPath: undefined })}><span>修改在别处做好的项目</span><ChevronRight size={19} /></button></section> : null}
          {phase === 'import' ? <MokoExistingPanel onInspected={onInspected} onSelectedProject={onSelectedProject} onOpened={onCreated} onBusyChange={setCreating} /> : null}
          {phase === 'goal' ? <section className="moko-choice-panel" aria-labelledby="moko-goal-title"><h2 id="moko-goal-title">想先做点什么？</h2><div className="moko-goal-grid">{onboardingGoals.map(value => { const Icon = goalIcons[value.id]; return <button key={value.id} className={`moko-goal${selectedGoal === value.id ? ' selected' : ''}`} aria-pressed={selectedGoal === value.id} onClick={() => { setSelectedGoal(value.id); setSelectedTask(undefined) }}><Icon size={29} /><strong>{value.id === 'mod' ? '制作模组' : value.name}</strong><span>{value.example}</span>{selectedGoal === value.id ? <Check className="moko-selected-check" size={18} /> : null}</button> })}</div><div className="moko-panel-actions"><button className="primary-button" disabled={!selectedGoal} onClick={() => { if (selectedGoal) update({ goal: selectedGoal, task: undefined, projectDraft: selectedGoal === session.goal ? session.projectDraft : undefined, phase: 'task', fieldIndex: 0, projectPath: undefined }) }}>就选这个<ArrowRight size={17} /></button></div></section> : null}
          {phase === 'task' && session.goal ? <section className="moko-choice-panel moko-tasks" aria-labelledby="moko-task-title"><h2 id="moko-task-title">从哪件事开始？</h2>{onboardingTasks[session.goal].map(value => <button key={value.id} className={`moko-choice${selectedTask === value.id ? ' selected' : ''}`} aria-pressed={selectedTask === value.id} onClick={() => setSelectedTask(value.id)}><span>{value.name}</span>{selectedTask === value.id ? <Check size={19} /> : <ChevronRight size={19} />}</button>)}<div className="moko-panel-actions"><button className="primary-button" disabled={!selectedTask} onClick={() => { if (selectedTask) update({ task: selectedTask, phase: 'features', fieldIndex: 0, projectPath: undefined }) }}>准备工具<ArrowRight size={17} /></button></div></section> : null}
          {toolRound ? <MokoToolsPanel session={session} onBusyChange={setToolsBusy} continueLabel={session.projectMode === 'existing' ? existingAnalysis?.studio?.available === false ? '重新识别项目' : existingProject ? '继续打开项目' : undefined : undefined} onContinue={() => update({ phase: session.projectPath && session.projectPath === project?.path ? 'complete' : session.projectMode === 'existing' && (!existingAnalysis && !existingProject || existingAnalysis?.studio?.available === false) ? 'import' : 'create' })} /> : null}
          {projectRound ? session.projectMode === 'existing' && existingProject ? <MokoExistingPanel selectedProject={existingProject} onInspected={onInspected} onSelectedProject={onSelectedProject} onOpened={onCreated} onBusyChange={setCreating} /> : <MokoProjectPanel session={session} update={update} analysis={session.projectMode === 'existing' ? existingAnalysis : null} onBusyChange={setCreating} onCreated={onCreated} /> : null}
          {complete ? <section className="moko-choice-panel moko-ready"><Check size={28} /><h2>准备好了</h2><span>{project?.name}</span></section> : null}
          {phase === 'handoff' && handoffError ? <section className="moko-choice-panel"><p className="moko-panel-error" role="alert">{handoffError}</p><div className="moko-panel-actions"><button className="primary-button" onClick={() => setHandoffAttempt(value => value + 1)}>重新进入灵感台</button></div></section> : null}
        </>}
      </div>
    </main>
    <section className="moko-dialogue" aria-label="茉可的对话"><span className="moko-name">茉可</span><div className="moko-line"><span aria-hidden="true">{dialogue.visible}</span><span className="moko-sr-only" role="status">{line.text}</span></div></section>
    <footer className="moko-footer"><div>{!resume && back ? <button className="moko-text-button" disabled={toolsBusy || creating} onClick={back}><ArrowLeft size={16} />上一步</button> : null}</div><span className="moko-continue-hint">{!dialogue.done ? '点击空白处显示全文' : pureDialogue && next ? '点击任意位置继续' : ''}</span><button className="moko-text-button" disabled={creating} onClick={() => update({ status: 'skipped' })}>直接进入工作台</button></footer>
  </dialog>, document.body)
}
