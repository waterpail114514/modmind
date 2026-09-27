import { useEffect } from 'react'
import { parseStudioDraft } from '../../../shared/soundStudio'
import { renderStudio } from './soundStudioEngine'
import { renderBeepBoxSong } from './beepboxMusic'

export default function SoundRenderBridge(): null {
  useEffect(() => window.modmind.production.sounds.onRenderRequest(request => {
    void (async () => {
      try {
        const draft = parseStudioDraft(JSON.stringify(request.draft))
        if (draft.mode !== 'music') throw new Error('工作台渲染请求不是音乐工程')
        window.modmind.production.sounds.completeRender(request.id, await (draft.music.beepboxSong ? renderBeepBoxSong(draft.music.beepboxSong, draft.gain) : renderStudio(draft)))
      } catch (error) { window.modmind.production.sounds.completeRender(request.id, undefined, String(error)) }
    })()
  }), [])
  return null
}
