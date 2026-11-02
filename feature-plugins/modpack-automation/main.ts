import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { applyOptimizationProfile, BUILTIN_OPTIMIZATION_PROFILES } from "./src/main/optimizationService"
import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "modpack-automation" }, () => handler(host.event(), ...(input.args as any[]))) }
diagnosticHandle('modpack:listOptimizationProfiles', () => BUILTIN_OPTIMIZATION_PROFILES);
diagnosticHandle('modpack:applyOptimizationProfile', async (_event, input: unknown) => {
    const project = host.requireProject();
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    if (!input || typeof input !== 'object')
        throw new Error('optimization profile input must be an object');
    const value = input as Record<string, unknown>;
    const profileId = typeof value.profileId === 'string' ? value.profileId : '';
    const builtIn = BUILTIN_OPTIMIZATION_PROFILES.find((profile) => profile.id === profileId);
    const profile = builtIn ?? value.profile as Parameters<typeof applyOptimizationProfile>[2];
    if (!profile || typeof profile !== 'object')
        throw new Error(`optimization profile not found: ${profileId}`);
    return applyOptimizationProfile(host.requireModProviderRegistry(), project, profile as Parameters<typeof applyOptimizationProfile>[2]);
});


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackApplyOptimizationProfile"> => {
return { modpackApplyOptimizationProfile: async (input) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const profileId = typeof input.profileId === 'string' ? input.profileId : '';
    const builtIn = host.featurePluginService.service<ReturnType<typeof import('../../feature-plugins/modpack-automation/main').activate>>('modpack-automation').BUILTIN_OPTIMIZATION_PROFILES.find((profile) => profile.id === profileId);
    const profile = builtIn ?? input.profile;
    if (!profile || typeof profile !== 'object')
        throw new Error(`optimization profile not found: ${profileId}`);
    return applyOptimizationProfile(host.requireModProviderRegistry(), project, profile as Parameters<typeof applyOptimizationProfile>[2], signal);
} }
}
actions["modpack_apply_optimization_profile"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackApplyOptimizationProfile!(input)
return { actions, createMcpHandlers, applyOptimizationProfile, BUILTIN_OPTIMIZATION_PROFILES,  }
}
