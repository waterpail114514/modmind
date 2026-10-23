import { randomUUID } from 'node:crypto'
import type { DownloadActivity, DownloadActivitySnapshot } from '../shared/types'
import { downloadFailureText } from '../shared/downloadFailure'

type ActivityInput = Pick<DownloadActivity, 'label'> & Partial<Pick<DownloadActivity, 'detail' | 'downloadedBytes' | 'totalBytes'>> & {
  retry?: () => Promise<void>
  cancel?: () => Promise<void>
  restart?: () => Promise<void>
}
type ActivityUpdate = Partial<Pick<DownloadActivity, 'label' | 'detail' | 'downloadedBytes' | 'totalBytes'>>

const COMPLETED_RETENTION_MS = 30_000
const MAX_ACTIVITIES = 80

function errorMessage(error: unknown): string {
  return downloadFailureText(error)
}

export class DownloadActivityStore {
  private readonly activities = new Map<string, DownloadActivity>()
  private readonly listeners = new Set<(snapshot: DownloadActivitySnapshot) => void>()
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>()
  private readonly retryOperations = new Map<string, () => Promise<void>>()
  private readonly cancelOperations = new Map<string, () => Promise<void>>()
  private readonly restartOperations = new Map<string, () => Promise<void>>()

  snapshot(): DownloadActivitySnapshot {
    const rank: Record<DownloadActivity['status'], number> = { downloading: 0, failed: 1, cancelled: 2, completed: 3 }
    return {
      activities: [...this.activities.values()]
        .sort((left, right) => rank[left.status] - rank[right.status] || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
        .map((activity) => ({
          ...activity,
          retryable: (activity.status === 'failed' || activity.status === 'cancelled') && this.retryOperations.has(activity.id),
          cancellable: activity.status === 'downloading' && this.cancelOperations.has(activity.id),
          restartable: activity.status === 'downloading' && this.restartOperations.has(activity.id)
        }))
    }
  }

  subscribe(listener: (snapshot: DownloadActivitySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(input: ActivityInput): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.activities.set(id, {
      id,
      label: input.label.trim().slice(0, 240) || '下载任务',
      detail: input.detail?.trim().slice(0, 500),
      status: 'downloading',
      downloadedBytes: Math.max(0, input.downloadedBytes ?? 0),
      ...(input.totalBytes !== undefined ? { totalBytes: Math.max(0, input.totalBytes) } : {}),
      startedAt: now,
      updatedAt: now
    })
    if (input.retry) this.retryOperations.set(id, input.retry)
    if (input.cancel) this.cancelOperations.set(id, input.cancel)
    if (input.restart) this.restartOperations.set(id, input.restart)
    this.trim()
    this.emit()
    return id
  }

  update(id: string, update: ActivityUpdate): void {
    const activity = this.activities.get(id)
    if (!activity || activity.status !== 'downloading') return
    this.activities.set(id, {
      ...activity,
      ...(update.label !== undefined ? { label: update.label.trim().slice(0, 240) || activity.label } : {}),
      ...(update.detail !== undefined ? { detail: update.detail.trim().slice(0, 500) } : {}),
      ...(update.downloadedBytes !== undefined ? { downloadedBytes: Math.max(0, update.downloadedBytes) } : {}),
      ...(update.totalBytes !== undefined ? { totalBytes: Math.max(0, update.totalBytes) } : {}),
      updatedAt: new Date().toISOString()
    })
    this.emit()
  }

  complete(id: string, detail?: string): void {
    const activity = this.activities.get(id)
    if (!activity) return
    const now = new Date().toISOString()
    this.activities.set(id, {
      ...activity,
      status: 'completed',
      ...(detail ? { detail: detail.trim().slice(0, 500) } : {}),
      ...(activity.totalBytes !== undefined ? { downloadedBytes: activity.totalBytes } : {}),
      updatedAt: now,
      finishedAt: now
    })
    this.retryOperations.delete(id)
    this.cancelOperations.delete(id)
    this.restartOperations.delete(id)
    this.scheduleCleanup(id)
    this.emit()
  }

  fail(id: string, error: unknown): void {
    const activity = this.activities.get(id)
    if (!activity) return
    const now = new Date().toISOString()
    this.activities.set(id, {
      ...activity,
      status: 'failed',
      error: errorMessage(error).trim().slice(0, 4_000) || '下载失败',
      updatedAt: now,
      finishedAt: now
    })
    this.emit()
  }

  async retry(id: string): Promise<DownloadActivitySnapshot> {
    const activity = this.activities.get(id)
    const operation = this.retryOperations.get(id)
    if (!activity || (activity.status !== 'failed' && activity.status !== 'cancelled') || !operation) return this.snapshot()

    this.clearCleanup(id)
    this.activities.set(id, {
      ...activity,
      status: 'downloading',
      detail: '正在校验已下载缓存并继续',
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined,
      finishedAt: undefined,
      updatedAt: new Date().toISOString()
    })
    this.emit()

    try {
      await operation()
      this.complete(id, '重试完成')
    } catch (error) {
      this.fail(id, error)
    }
    return this.snapshot()
  }

  async cancel(id: string): Promise<DownloadActivitySnapshot> {
    const activity = this.activities.get(id)
    const operation = this.cancelOperations.get(id)
    if (!activity || activity.status !== 'downloading' || !operation) return this.snapshot()
    this.activities.set(id, { ...activity, detail: '正在停止下载', updatedAt: new Date().toISOString() })
    this.emit()
    try {
      await operation()
      const current = this.activities.get(id)
      if (current?.status === 'downloading') {
        const now = new Date().toISOString()
        this.activities.set(id, { ...current, status: 'cancelled', detail: '下载已停止，已完成的文件将被复用', updatedAt: now, finishedAt: now })
        this.emit()
      }
    } catch (error) {
      this.fail(id, error)
    }
    return this.snapshot()
  }

  async restart(id: string): Promise<DownloadActivitySnapshot> {
    const activity = this.activities.get(id)
    const operation = this.restartOperations.get(id)
    if (!activity || activity.status !== 'downloading' || !operation) return this.snapshot()
    this.activities.set(id, {
      ...activity,
      detail: '正在停止当前连接并从缓存重启',
      downloadedBytes: 0,
      totalBytes: undefined,
      updatedAt: new Date().toISOString()
    })
    this.emit()
    try {
      await operation()
      this.complete(id, '重启后下载完成')
    } catch (error) {
      this.fail(id, error)
    }
    return this.snapshot()
  }

  dismiss(id: string): DownloadActivitySnapshot {
    const activity = this.activities.get(id)
    if (activity?.status !== 'downloading') {
      this.activities.delete(id)
      this.retryOperations.delete(id)
      this.cancelOperations.delete(id)
      this.restartOperations.delete(id)
      this.clearCleanup(id)
      this.emit()
    }
    return this.snapshot()
  }

  clearFinished(): DownloadActivitySnapshot {
    for (const [id, activity] of this.activities) {
      if (activity.status === 'downloading') continue
      this.activities.delete(id)
      this.retryOperations.delete(id)
      this.cancelOperations.delete(id)
      this.restartOperations.delete(id)
      this.clearCleanup(id)
    }
    this.emit()
    return this.snapshot()
  }

  async run<T>(input: ActivityInput, operation: (id: string) => Promise<T>): Promise<T> {
    const id = this.start(input)
    try {
      const result = await operation(id)
      this.complete(id)
      return result
    } catch (error) {
      this.fail(id, error)
      throw error
    }
  }

  private scheduleCleanup(id: string): void {
    this.clearCleanup(id)
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(id)
      if (this.activities.get(id)?.status === 'completed') {
        this.activities.delete(id)
        this.emit()
      }
    }, COMPLETED_RETENTION_MS)
    timer.unref?.()
    this.cleanupTimers.set(id, timer)
  }

  private clearCleanup(id: string): void {
    const timer = this.cleanupTimers.get(id)
    if (timer) clearTimeout(timer)
    this.cleanupTimers.delete(id)
  }

  private trim(): void {
    if (this.activities.size <= MAX_ACTIVITIES) return
    const removable = [...this.activities.values()]
      .filter((activity) => activity.status !== 'downloading')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    for (const activity of removable) {
      if (this.activities.size <= MAX_ACTIVITIES) break
      this.activities.delete(activity.id)
      this.retryOperations.delete(activity.id)
      this.cancelOperations.delete(activity.id)
      this.restartOperations.delete(activity.id)
      this.clearCleanup(activity.id)
    }
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const downloadActivities = new DownloadActivityStore()
