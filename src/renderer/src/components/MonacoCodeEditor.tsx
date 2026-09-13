import Editor from '@monaco-editor/react'
import { useRef } from 'react'
import '../monaco'

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
  save.current = readOnly ? () => undefined : onSave
  return <Editor
    path={path}
    language={language}
    theme={darkMode ? 'vs-dark' : 'vs'}
    value={value}
    onChange={(nextValue) => onChange(nextValue ?? '')}
    onMount={(editor, monaco) => { editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current()) }}
    options={{
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
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
