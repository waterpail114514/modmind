import { Children, isValidElement, type ReactNode } from 'react'

const sections = [
  ['settings-ai', 'AI 模型'],
  ['settings-appearance', '外观'],
  ['settings-approval', '执行审批'],
  ['settings-image', '图像'],
  ['settings-network', '网络'],
  ['settings-notifications', '通知'],
  ['settings-agents', '外部 Agent'],
  ['settings-java', 'Java'],
  ['settings-build', '构建'],
  ['settings-mcp', 'MCP'],
  ['settings-remote', '远程构建'],
  ['settings-diagnostics', '诊断'],
  ['settings-sidebar-order', '重置侧栏'],
  ['settings-legal', '许可证']
] as const

export default function SettingsSections({ children }: { children: ReactNode }): React.JSX.Element {
  const content = new Map(Children.toArray(children).flatMap(child =>
    isValidElement<{ id?: string }>(child) && child.props.id ? [[child.props.id, child] as const] : []))
  return <>
    <nav className="settings-index" aria-label="设置分类">
      {sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
    </nav>
    {sections.map(([id]) => content.get(id))}
  </>
}
