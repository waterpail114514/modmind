/** Replies reference files, never remote URLs or embedded image payloads. */
export function projectImageReference(href: string): string | undefined {
  let value = href.trim()
  try {
    if (value.startsWith('modmind-image:')) value = new URL(value).searchParams.get('path') ?? ''
    else value = decodeURIComponent(value)
  } catch { return undefined }
  value = value.replaceAll('\\', '/')
  if (!value || /[\x00-\x1f]/.test(value) || value.startsWith('//')) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return undefined
  if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(value)) return undefined
  return value
}

export const PROJECT_REPLY_IMAGES_PROMPT = '回复可附带当前项目中已有的图片（效果图、纹理或截图）：使用 ![简短说明](项目相对路径)，路径中的空格使用 URL 编码，例如 ![效果图](.modmind/image-studio/generated/example.png)。只引用工具实际返回或已确认存在的图片路径；不要编造文件、嵌入 base64 或使用远程图片 URL。界面会提供清晰预览、点击放大和缩放。生成成功后在回复中附上返回的图片路径，并说明它是概念效果图还是实际运行截图。'
