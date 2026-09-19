import { Copy, FolderPlus, Link, LoaderCircle } from 'lucide-react'
import type { ModpackManifest } from '../../../shared/types'
import { reportClientFailure } from '../lib/clientFailure'
import MoreActions from './MoreActions'

export default function ImportModpackModule({ busy, setBusy, onImported, onNotice }: {
  busy: string
  setBusy: (value: string) => void
  onImported: (manifest: ModpackManifest) => void
  onNotice: (message: string) => void
}): React.JSX.Element {
  const importModule = async (mode: 'copy' | 'link'): Promise<void> => {
    if (busy) return
    setBusy('import-module'); onNotice('')
    try {
      const manifest = await window.modmind.modpack.importModule(mode)
      if (manifest) {
        onImported(manifest)
        onNotice(mode === 'copy' ? '已复制模组项目到整合包' : '已添加原项目引用')
      }
    } catch (error) { onNotice(reportClientFailure(error)) }
    finally { setBusy('') }
  }
  return <MoreActions label="导入已有模组项目" text="导入已有项目" icon={busy === 'import-module' ? <LoaderCircle className="spin" size={15} /> : <FolderPlus size={15} />}>
    <button type="button" className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void importModule('copy')}><Copy size={15} />复制到整合包</button>
    <button type="button" className="secondary-button compact" disabled={Boolean(busy)} onClick={() => void importModule('link')}><Link size={15} />直接使用原项目</button>
  </MoreActions>
}
