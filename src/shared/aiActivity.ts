/** Bounded snapshots shared by live output and durable conversation replay. */
export interface AiActivity {
  kind: 'command' | 'file' | 'tool' | 'build' | 'test' | 'approval' | 'search'
  title: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  completedAt?: string
  tool?: string
  command?: string
  detail?: string
  output?: string
  files?: Array<{ path: string; operation: 'create' | 'edit' | 'delete'; added?: number; removed?: number }>
  progress?: { current: number; total: number }
}
