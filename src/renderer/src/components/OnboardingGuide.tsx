import { useEffect, useState } from 'react'
import type { BeginnerAiPreferences, DeviceConnectionState, ExistingProjectAnalysis, ProjectInfo } from '../../../shared/types'
import { onboardingGoalForProject, onboardingTasks, resumeOnboarding, type OnboardingSession } from '../onboarding'
import MokoOnboarding from './MokoOnboarding'

/** The complete setup stays on the tutorial stage; only completed projects enter the workbench. */
export default function OnboardingGuide({ session, update, project, ready, account, onAccountChange, onModelApplied, onCreated, onNavigate, onBeginInspiration }: {
  session: OnboardingSession
  update: (patch: Partial<OnboardingSession>) => void
  project: ProjectInfo | null
  ready: boolean
  account: DeviceConnectionState
  onAccountChange: (state: DeviceConnectionState) => void
  onModelApplied: (preferences: BeginnerAiPreferences) => void
  onCreated: (project: ProjectInfo) => void
  onNavigate: (id: string) => void
  onBeginInspiration: () => Promise<void>
}): React.JSX.Element | null {
  const [offerResume, setOfferResume] = useState(session.status === 'paused')
  const [existingAnalysis, setExistingAnalysis] = useState<ExistingProjectAnalysis | null>(null)
  const [existingProject, setExistingProject] = useState<ProjectInfo | null>(null)
  const [, setTick] = useState(0)
  const running = session.status === 'running'
  useEffect(() => {
    if (!ready || (!running && !offerResume)) return
    const timer = window.setInterval(() => setTick(value => value + 1), 250)
    return () => clearInterval(timer)
  }, [ready, running, offerResume])
  const covered = document.body.hasAttribute('data-loading-covered')
  const otherDialog = Boolean(document.querySelector('dialog:modal:not(.moko-onboarding),.modal-backdrop,.interaction-dialog-backdrop'))
  if (!ready || covered && session.phase !== 'handoff' || otherDialog || !running && !offerResume) return null
  if (running && session.phase === 'inspiration') return null
  const pause = (): void => { setOfferResume(false); update({ status: 'paused' }) }
  return <MokoOnboarding session={session} update={update} account={account} onAccountChange={onAccountChange} onModelApplied={onModelApplied} project={project} resume={session.status === 'paused' && offerResume} onPause={pause}
    onResume={() => { setOfferResume(false); update(resumeOnboarding(session, project?.path)) }}
    onExperienced={() => { update({ experience: 'returning', status: 'done' }); onNavigate('workspace') }}
    existingAnalysis={existingAnalysis}
    existingProject={existingProject}
    onInspected={analysis => {
      const goal = onboardingGoalForProject(analysis.inferred)
      if (!goal) return
      setExistingAnalysis(analysis)
      setExistingProject(null)
      const task = onboardingTasks[goal].find(value => value.view === 'workspace') ?? onboardingTasks[goal][0]
      update({ projectMode: 'existing', phase: 'features', goal, task: task.id, fieldIndex: 0, projectPath: undefined, importSourcePath: analysis.sourcePath, projectDraft: session.importSourcePath === analysis.sourcePath ? session.projectDraft : undefined })
    }}
    onSelectedProject={selected => {
      const goal = onboardingGoalForProject(selected)
      if (!goal) return
      setExistingProject(selected); setExistingAnalysis(null)
      const task = onboardingTasks[goal].find(value => value.view === 'workspace') ?? onboardingTasks[goal][0]
      update({ projectMode: 'existing', goal, task: task.id, phase: 'features', fieldIndex: 0, projectPath: undefined, importSourcePath: selected.path, projectDraft: undefined })
    }}
    onCreated={created => { update({ phase: 'complete', projectPath: created.path }); onCreated(created) }}
    onFinish={onBeginInspiration} />
}
