import type { AiNotice } from '../../../shared/types'

export function AiNoticeDetails({ notice }: { notice?: AiNotice }): React.JSX.Element | null {
  if (!notice) return null
  return <details className="ai-notice-details">
    <summary>查看详情{notice.occurrences && notice.occurrences > 1 ? ` · 已合并 ${notice.occurrences} 条` : ''}</summary>
    <p>{notice.detail}</p>
  </details>
}
