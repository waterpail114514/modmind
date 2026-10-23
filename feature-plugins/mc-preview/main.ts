import { activate as createPreview } from '../../vendor/mc-offline-tool/preview-feature/backend/main.js'
import { bindProjectRuntime } from '../../vendor/mc-offline-tool/src/host-runtime.mjs'

export function activate() { return bindProjectRuntime(createPreview()) }
