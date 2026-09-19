import { getThemePalette, themePresets, type CustomThemeColors } from '../../shared/appTheme'
import { scrollbarColors } from '../../shared/scrollbars'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import cssWorker from 'monaco-editor/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker?worker'

globalThis.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    return new editorWorker()
  }
}

export function defineEditorTheme(name: string, preset: string, dark: boolean, custom?: CustomThemeColors): void {
  const p = getThemePalette(preset, dark ? 'dark' : 'light', custom)
  const scrollbars = scrollbarColors(p)
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
    colors: {
      'scrollbar.shadow': 'transparent', 'scrollbarSlider.background': scrollbars.idle,
      'scrollbarSlider.hoverBackground': scrollbars.hover, 'scrollbarSlider.activeBackground': scrollbars.active,
      focusBorder: p.canvas, activeContrastBorder: p.canvas,
      'editor.background': p.canvas, 'editor.foreground': p.text, 'editorGutter.background': p.canvas,
      'editor.lineHighlightBorder': p.canvas, 'editor.lineHighlightBackground': p.panel,
      'editor.selectionBackground': p.selection, 'editor.inactiveSelectionBackground': p.selection,
      'editorWidget.background': p.raised, 'editorWidget.border': p.line,
      'input.background': p.surface, 'input.foreground': p.text, 'input.border': p.line,
      'inputOption.activeBorder': p.focus,
      'list.focusOutline': p.selection, 'list.focusAndSelectionOutline': p.selection,
      'list.focusBackground': p.selection, 'list.focusForeground': p.text,
      'list.activeSelectionBackground': p.selection, 'list.activeSelectionForeground': p.text
    }
  })
}
for (const preset of themePresets) for (const dark of [false, true]) {
  defineEditorTheme('modmind-' + preset.id + (dark ? '-dark' : '-light'), preset.id, dark)
}
loader.config({ monaco })
