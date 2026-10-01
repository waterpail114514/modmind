import * as buildRuntime from './buildRuntime'
import * as creationFeedbackService from './creationFeedbackService'
import * as diagnosticLog from './diagnosticLog'
import * as downloadActivityService from './downloadActivityService'
import * as downloadService from './downloadService'
import * as modpackService from './modpackService'
import * as modpackContentMetadata from './modpackContentMetadata'
import * as curseForgePackMetadata from './curseForgePackMetadata'
import * as agentProtection from './agentProtection'
import * as nativeFeatureServices from './nativeFeatureServices'
import * as networkRequest from './networkRequest'
import * as processTree from './processTree'
import * as documentRead from './documentRead'
import * as projectTextRead from './projectTextRead'
import * as inspirationResearch from './inspirationResearch'

export const featureHostRuntime = Object.freeze({
  buildRuntime, creationFeedbackService, diagnosticLog, downloadActivityService, downloadService, modpackService, modpackContentMetadata, curseForgePackMetadata,
  agentProtection, nativeFeatureServices, networkRequest, processTree, documentRead, projectTextRead, inspirationResearch
})
