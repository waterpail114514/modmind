import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { ScrollArea } from './AppScrollbars'
import { settingsCategories as categories, settingsSections as sections, findSettingsSections } from '../settingsDefinitions'

export default function SettingsSections({ children, feedback = '', initialSection = '' }: { children: ReactNode; feedback?: string; initialSection?: string }): React.JSX.Element {
  const [activeCategory, setActiveCategory] = useState<string>(() => sections.find(section => section.id === initialSection)?.category ?? 'general')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = 0
  }, [activeCategory, query])
  const content = new Map(Children.toArray(children).flatMap(child =>
    isValidElement<{ id?: string }>(child) && child.props.id ? [[child.props.id, child] as const] : []))
  const { searching, visibleSections } = findSettingsSections(new Set(content.keys()), activeCategory, query)
  const visibleIds = new Set<string>(visibleSections.map(section => section.id))
  const clearSearch = (): void => { setQuery(''); searchRef.current?.focus() }
  return <>
    <div className="settings-navigation">
      <div className="settings-search-row">
        <div className="settings-search" role="search">
          <Search size={17} aria-hidden="true" />
          <input ref={searchRef} type="search" aria-label="搜索设置" placeholder="搜索设置，例如模型、代理、通知" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') clearSearch() }} />
          {query && <button type="button" aria-label="清除搜索" onClick={clearSearch}><X size={15} /></button>}
        </div>
        <span className="settings-save-feedback" role="status">{feedback}</span>
      </div>
      <nav className="settings-categories" aria-label="设置分类">
        {categories.map(item => <button key={item.id} type="button" aria-current={!searching && activeCategory === item.id ? 'page' : undefined} onClick={() => { setActiveCategory(item.id); setQuery('') }}>{item.label}</button>)}
      </nav>
    </div>
    <ScrollArea className="settings-scroll-area" ref={scrollRef} onClickCapture={event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-settings-target]')?.dataset.settingsTarget
      const category = sections.find(section => section.id === target)?.category
      if (category) { setActiveCategory(category); setQuery('') }
    }}>
    {searching && <p className="settings-search-count" role="status">找到 {visibleSections.length} 个相关设置分区</p>}
    <div className="settings-category-content">
      {sections.map(section => <div key={section.id} hidden={!visibleIds.has(section.id)}>
        {content.get(section.id)}
      </div>)}
    </div>
    {searching && visibleSections.length === 0 && <div className="settings-empty">
      <Search size={24} aria-hidden="true" />
      <strong>没有找到相关设置</strong>

      <button className="secondary-button" type="button" onClick={clearSearch}>清除搜索</button>
    </div>}
    </ScrollArea>
  </>
}
