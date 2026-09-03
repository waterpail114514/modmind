import { useEffect, useState } from 'react'
import { CircleHelp, CircleCheck, X } from 'lucide-react'
import { getGuideForView, pageGuideSeenKey, GUIDE_AUTO_DISABLED_KEY, WELCOME_TOUR_SEEN_KEY, WELCOME_TOUR_STEPS } from '../pageGuides'
import type { SidebarViewId } from '../../../shared/types'

/**
 * 「本页指南」弹层：当前页面的功能介绍 + 分步教程。
 * - 标题栏的帮助按钮打开
 * - 用户首次进入某个页面时自动弹出一次（见 App.tsx 的 effect）
 * - 配置了互动引导的页面，底部会出现「跟着步骤操作」按钮，一键启动聚光高亮引导
 */
export function PageGuideModal({ view, open, onClose, onLaunchTour }: { view: SidebarViewId; open: boolean; onClose: () => void; onLaunchTour?: () => void }): React.JSX.Element | null {
  const [disableAutoShow, setDisableAutoShow] = useState(false)

  useEffect(() => {
    if (open) setDisableAutoShow(false)
  }, [open, view])

  if (!open) return null
  const guide = getGuideForView(view)

  const close = (): void => {
    if (disableAutoShow) {
      try {
        localStorage.setItem(GUIDE_AUTO_DISABLED_KEY, '1')
      } catch {
        /* localStorage 不可用时忽略 */
      }
    }
    onClose()
  }

  return (
    <div className="modal-backdrop guide-backdrop" role="dialog" aria-modal="true" aria-label={`${guide.title}使用指南`} onClick={close}>
      <div className="guide-modal" onClick={(event) => event.stopPropagation()}>
        <header className="guide-modal-head">
          <div className="guide-modal-icon"><CircleHelp size={18} /></div>
          <div>
            <strong>{guide.title} · 使用指南</strong>
            <span>{guide.summary}</span>
          </div>
          <button className="bb-tool-button" type="button" title="关闭" aria-label="关闭指南" onClick={close}><X size={15} /></button>
        </header>
        <ol className="guide-steps">
          {guide.steps.map((step, index) => (
            <li key={step.title} className="guide-step">
              <span className="guide-step-index">{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </div>
            </li>
          ))}
        </ol>
        <footer className="guide-modal-foot">
          <label className="guide-never">
            <input type="checkbox" checked={disableAutoShow} onChange={(event) => setDisableAutoShow(event.target.checked)} />
            <span>以后所有页面都不再自动弹出指南（仍可随时点标题栏问号查看）</span>
          </label>
          <div className="guide-modal-foot-actions">
            {onLaunchTour ? <button className="guide-primary-button" type="button" onClick={onLaunchTour}>跟着步骤操作</button> : null}
            <button className={onLaunchTour ? 'guide-ghost-button' : 'guide-primary-button'} type="button" onClick={close}>开始探索</button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/**
 * 新手欢迎引导：首次启动展示一次，4 步讲清 ModMind 的使用流程。
 * 可一键启动「全局互动引导」，聚光高亮侧栏 / 专业模式 / 帮助按钮等外壳元素。
 */
export function WelcomeTour({ onLaunchShellTour }: { onLaunchShellTour?: () => void }): React.JSX.Element | null {
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(WELCOME_TOUR_SEEN_KEY)
    } catch {
      return false
    }
  })

  const close = (): void => {
    try {
      localStorage.setItem(WELCOME_TOUR_SEEN_KEY, 'done')
    } catch {
      /* localStorage 不可用时忽略，仅本次会话不再显示 */
    }
    setOpen(false)
  }

  if (!open) return null

  return (
    <div className="modal-backdrop guide-backdrop" role="dialog" aria-modal="true" aria-label="ModMind 快速上手" onClick={close}>
      <div className="guide-modal welcome-tour" onClick={(event) => event.stopPropagation()}>
        <header className="guide-modal-head">
          <div className="guide-modal-icon welcome"><CircleCheck size={18} /></div>
          <div>
            <strong>欢迎来到 ModMind</strong>
            <span>4 步上手：从想法到可发布的 Minecraft mod</span>
          </div>
          <button className="bb-tool-button" type="button" title="关闭" aria-label="关闭欢迎引导" onClick={close}><X size={15} /></button>
        </header>
        <ol className="guide-steps">
          {WELCOME_TOUR_STEPS.map((step) => (
            <li key={step.title} className="guide-step">
              <div>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </div>
            </li>
          ))}
        </ol>
        <footer className="guide-modal-foot">
          <span className="guide-hint">每个页面右上角都有「本页指南」按钮，随时查看该页的详细用法。</span>
          <div className="guide-modal-foot-actions">
            {onLaunchShellTour ? <button className="guide-primary-button" type="button" onClick={() => { close(); onLaunchShellTour() }}>跟着步骤认识界面</button> : null}
            <button className={onLaunchShellTour ? 'guide-ghost-button' : 'guide-primary-button'} type="button" onClick={close}>开始使用</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
