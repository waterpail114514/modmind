import { useEffect, useState } from 'react'

interface Portrait { family: string; src: string }

export default function QuotaModelCharacter({ family, src, animated, direction }: Portrait & { animated: boolean; direction: 'next' | 'previous' }) {
  const [{ displayed, portraits }, setView] = useState<{ displayed: Portrait; portraits: Portrait[] }>({
    displayed: { family, src }, portraits: [{ family, src }]
  })

  useEffect(() => {
    let cancelled = false
    const image = new Image()
    image.src = src
    // Keep the outgoing art until the next local image is decoded. A newer
    // selection cancels this result, so slow loads cannot restore an old family.
    const show = () => {
      if (cancelled) return
      const next = { family, src }
      setView(current => ({
        displayed: next,
        portraits: animated ? [...current.portraits.filter(portrait => portrait.family !== family), next] : [next]
      }))
    }
    void image.decode().then(show).catch(() => {
      if (cancelled) return
      if (image.complete && image.naturalWidth > 0) show()
      else setView({ portraits: [], displayed: { family, src } })
    })
    return () => { cancelled = true }
  }, [family, src, animated])

  useEffect(() => {
    // Also retire layers when a hidden window suppresses transitionend.
    const timer = setTimeout(() => setView(current => current.displayed !== displayed ? current : {
      ...current, portraits: current.portraits.filter(portrait => portrait.family === current.displayed.family)
    }), 440)
    return () => clearTimeout(timer)
  }, [displayed])

  return <div className="quota-model-character" data-family={family} data-animated={animated} data-direction={direction}>
    {portraits.map(portrait => <div key={portrait.family} className="quota-model-character-layer"
      data-family={portrait.family} data-active={portrait.family === displayed.family} aria-hidden={portrait.family !== displayed.family}
      onTransitionEnd={event => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity' && portrait.family !== displayed.family) {
          setView(current => current.displayed.family === portrait.family ? current : {
            ...current, portraits: current.portraits.filter(value => value.family !== portrait.family)
          })
        }
      }}>
      <img className="quota-model-character-soft" src={portrait.src} alt="" draggable={false} />
      <img className="quota-model-character-sharp" src={portrait.src} alt="" draggable={false} />
      {portrait.family === '推荐' && <small className="quota-model-character-note">暂定，不代表最终效果</small>}
    </div>)}
  </div>
}
