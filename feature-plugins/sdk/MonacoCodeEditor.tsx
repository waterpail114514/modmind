type Editor = typeof import('../../src/renderer/src/components/MonacoCodeEditor').default
export default (window as unknown as { __modmindFeatureHost: { MonacoCodeEditor: Editor } }).__modmindFeatureHost.MonacoCodeEditor
