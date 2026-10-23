// Compatibility exports for service consumers. Feature entry points import only their owned capabilities.
export { assertShaderProject } from '../../../shader-shared/src/main/shaderFiles'
export { readShaderFile, shaderInventory, saveShaderFile, setShaderOptions, undoShaderChange, expandedShader } from '../../../shader-shared/src/main/shaderSourceService'
export { validateShader } from '../../../shader-shared/src/main/shaderValidationService'
export { exportShader } from '../../../shader-shared/src/main/shaderExportService'
export { bindShaderInstance, shaderTestState, deployShader } from '../../../shader-shared/src/main/shaderTestingService'
export { inspectShaderSource } from './shaderAdoption'
