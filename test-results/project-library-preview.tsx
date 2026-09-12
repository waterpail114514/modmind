import React, {useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Plus,FolderOpen,PackageOpen,Binary,ChevronRight,Box,X,Pencil,Search} from 'lucide-react';
import {platformLabel} from '../src/shared/projectPlatform';
import '../src/renderer/src/styles.css';

function ProjectLauncher({
  projects,
  onCreate,
  onOpen,
  onAdopt,
  onImportModJar,
  onSelect,
  onRemove,
  onRename
}: {
  projects: ProjectInfo[]
  onCreate: () => void
  onOpen: () => void
  onAdopt: () => void
  onImportModJar: () => void
  onSelect: (project: ProjectInfo) => void
  onRemove: (project: ProjectInfo) => void
  onRename: (project: ProjectInfo) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ project: ProjectInfo; x: number; y: number } | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const filteredProjects = projects.filter((project) => `${project.name} ${project.path} ${platformLabel(project.loader)} ${project.minecraftVersion}`.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase()))

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  return (
    <main className="project-launcher">
      <div className="project-launcher-header">
        <div><h1>项目</h1><p>选择最近项目或开始一个新项目</p></div>
      </div>
      <div className="project-launcher-list">
        <button className="project-launcher-action" type="button" onClick={onCreate}>
          <span className="project-launcher-icon new"><Plus size={20} /></span>
          <span><strong>新建项目</strong><small>创建 Minecraft Mod 工程或整合包</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onOpen}>
          <span className="project-launcher-icon open"><FolderOpen size={19} /></span>
          <span><strong>打开已有项目</strong><small>从其他位置选择 ModMind 项目文件夹</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onAdopt}>
          <span className="project-launcher-icon adopt"><PackageOpen size={19} /></span>
          <span><strong>接管现有项目</strong><small>支持项目文件夹或压缩包（ZIP、MRPack），识别完整工程、残缺源码或 API 文档</small></span>
          <ChevronRight size={17} />
        </button>
        <button className="project-launcher-action" type="button" onClick={onImportModJar}>
          <span className="project-launcher-icon adopt"><Binary size={19} /></span>
          <span><strong>接管现成模组</strong><small>识别 JAR 的加载器与 Minecraft 版本，反编译后直接创建 ModMind 项目</small></span>
          <ChevronRight size={17} />
        </button>
      </div>
        <section className="recent-projects">
          <div className="recent-projects-toolbar">
            <h2>最近项目 <span>{projects.length}</span></h2>
            {projects.length > 0 ? <label className="project-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索最近项目" placeholder="搜索名称、路径或版本" value={projectQuery} onChange={event => setProjectQuery(event.target.value)} />{projectQuery ? <button type="button" aria-label="清除项目搜索" onClick={() => setProjectQuery('')}><X size={13} /></button> : null}</label> : null}
          </div>
          <div className="recent-project-list">
            {filteredProjects.map((recent) => (
              <div className="recent-project-row" key={recent.path} onContextMenu={(event) => { event.preventDefault(); setMenu({ project: recent, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 92) }) }}>
                <button className="recent-project-main" type="button" onClick={() => onSelect(recent)}>
                  <span className="project-launcher-icon project"><Box size={18} /></span>
                  <span><strong>{recent.name}</strong><small title={recent.path}>{recent.path}</small></span>
                  <span className="recent-project-meta">{platformLabel(recent.loader)} · {recent.minecraftVersion}</span>
                </button>
                <button className="recent-project-remove" type="button" title="删除项目" aria-label={`删除项目 ${recent.name}`} onClick={() => onRemove(recent)}><X size={15} /></button>
              </div>
            ))}
            {!filteredProjects.length ? <div className="recent-project-empty"><FolderOpen size={24} strokeWidth={1.4} aria-hidden="true" /><strong>{projects.length ? '没有找到匹配的项目' : '你的项目会出现在这里'}</strong><p>{projects.length ? '试试其他名称、路径或 Minecraft 版本。' : '新建一个项目，或打开已有作品，继续你的创作。'}</p></div> : null}
          </div>
        </section>
      {menu ? <div className="project-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => { onRename(menu.project); setMenu(null) }}><Pencil size={14} />重命名项目</button>
        <button type="button" role="menuitem" onClick={() => { onRemove(menu.project); setMenu(null) }}><X size={14} />删除项目</button>
      </div> : null}
    </main>
  )
}

const noop=()=>{}; const projects=[{name:'林间物语',path:'D:/Minecraft/forest-world',loader:'fabric',minecraftVersion:'1.21.1'},{name:'机械工坊',path:'D:/Minecraft/create-workshop',loader:'forge',minecraftVersion:'1.20.1'}];
createRoot(document.getElementById('root')!).render(<div className='app-shell' style={{display:'flex',height:'100dvh'}}><ProjectLauncher projects={projects} onCreate={noop} onOpen={noop} onAdopt={noop} onImportModJar={noop} onSelect={p=>window.selected=p.name} onRemove={noop} onRename={noop}/></div>);