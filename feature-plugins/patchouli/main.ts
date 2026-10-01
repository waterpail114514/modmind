import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import { applyKeybindPreset, readKeybindState, writeFtbQuestChapter, writePatchouliBook } from "../modpack-content/src/main/modpackContentService"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
diagnosticHandle('modpack:writePatchouliBook', (_event, input: unknown) => writePatchouliBook(host.requireProject(), input as Parameters<typeof writePatchouliBook>[1]));


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackWritePatchouliBook"> => {
return { modpackWritePatchouliBook: async (input) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const paths = await writePatchouliBook(project, input as unknown as Parameters<typeof writePatchouliBook>[1]);
    return { success: true, paths };
} }
}
actions["modpack_write_patchouli_book"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackWritePatchouliBook!(input)
return { actions, createMcpHandlers,  }
}
