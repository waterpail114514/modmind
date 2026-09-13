import { useRef, useState } from 'react'
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch'
import { Minus, Plus, Maximize } from 'lucide-react'

/** Shared image viewer; editing continues to use the existing MiniPaint editor. */
export default function ResourceImagePreview({ src, name }: { src: string; name: string }): React.JSX.Element {
  const transform = useRef<ReactZoomPanPinchRef>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scale, setScale] = useState(1)
  const [error, setError] = useState(false)
  const fit = (width = size.width, height = size.height): void => {
    const bounds = viewport.current?.getBoundingClientRect()
    if (bounds && width && height) transform.current?.centerView(Math.min(16, (bounds.width - 40) / width, (bounds.height - 40) / height), 0)
  }
  return <div className="resource-image-preview">
    <div className="resource-preview-controls">
      <span>{size.width ? `${size.width} × ${size.height} px` : '读取图片…'}</span>
      <button className="icon-button" title="缩小" onClick={() => transform.current?.zoomOut(.3, 0)}><Minus size={15} /></button>
      <button className="secondary-button" title="按原始像素大小显示" onClick={() => transform.current?.centerView(1, 0)}>{Math.round(scale * 100)}%</button>
      <button className="icon-button" title="放大" onClick={() => transform.current?.zoomIn(.3, 0)}><Plus size={15} /></button>
      <button className="secondary-button" onClick={() => fit()}><Maximize size={15} />适应窗口</button>
    </div>
    {error ? <div className="resource-pack-notice" role="alert">无法解码此图片，请检查图片文件是否完整。</div> : null}
    <div className="resource-image-viewport" ref={viewport}>
      <TransformWrapper ref={transform} minScale={.01} maxScale={32} centerOnInit limitToBounds={false} onTransform={(_, state) => setScale(state.scale)} autoAlignment={{ disabled: true }} velocityAnimation={{ disabled: true }} doubleClick={{ disabled: true }}>
        <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }}>
          <img src={src} alt={name} draggable={false} onError={() => setError(true)} onLoad={event => {
            setError(false)
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget
            setSize({ width, height }); fit(width, height)
          }} />
        </TransformComponent>
      </TransformWrapper>
    </div>
  </div>
}
