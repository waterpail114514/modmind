import Editor from '@monaco-editor/react'
import { useMemo, useRef } from 'react'
import { defineEditorTheme } from '../monaco'
import { useAppAppearance } from '../theme'
import { scrollbarMetrics } from '../../../shared/scrollbars'

export default function MonacoCodeEditor({
  path,
  language,
  value,
  darkMode,
  onChange,
  onSave,
  readOnly = false
}: {
  path: string
  language: string
  value: string
  darkMode: boolean
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
}): React.JSX.Element {
  const save = useRef(onSave)
  const { themePreset, customThemeColors } = useAppAppearance()
  const theme = useMemo(() => {
    const mode = darkMode ? 'dark' : 'light'
    const name = `modmind-${themePreset}-${mode}`
    defineEditorTheme(name, themePreset, darkMode, customThemeColors)
    return name
  }, [themePreset, darkMode, customThemeColors])
  save.current = readOnly ? () => undefined : onSave
  return <Editor
    path={path}
    language={language}
    theme={theme}
    value={value}
    onChange={(nextValue) => onChange(nextValue ?? '')}
    onMount={(editor, monaco) => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current()) }}
    options={{
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: scrollbarMetrics.size, horizontalScrollbarSize: scrollbarMetrics.size, useShadows: false, verticalHasArrows: false, horizontalHasArrows: false },
      fontSize: 12,
      lineHeight: 20,
      padding: { top: 14, bottom: 14 },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 4,
      renderWhitespace: 'selection'
    }}
  />
}
