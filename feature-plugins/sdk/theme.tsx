type Theme = typeof import('../../src/renderer/src/theme')
const theme = (window as unknown as { __modmindFeatureHost: { theme: Theme } }).__modmindFeatureHost.theme
export const useAppAppearance = theme.useAppAppearance
