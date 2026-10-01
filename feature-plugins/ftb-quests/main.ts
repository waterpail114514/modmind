import { onModpackManifestChanged, addModpackFiles, addModpackModule, adoptExternalModpack, createModpackTemplate, createModrinthPackArchive, isModpackProject, readModpackManifest, removeModpackFile, removeModpackModule, updateModpackModuleSide, auditImportedPackArtifacts } from "../../src/main/modpackService"
import { inspectFtbQuestIcon, refreshFtbQuestResources, resolveFtbQuestDependencyTexture, resolveFtbQuestIcon, resolveFtbQuestItemNames, resolveFtbQuestShapes } from "./src/main/ftbquesticonservice"
import path from 'node:path'
import { listFtbQuestBackups, readFtbQuestBook, restoreFtbQuestBackup, saveFtbQuestBook } from "./src/main/ftbQuestBookService"
import { applyKeybindPreset, readKeybindState, writeFtbQuestChapter, writePatchouliBook } from "../modpack-content/src/main/modpackContentService"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const ftbProject = (expected: unknown): import('../../src/shared/types').ProjectInfo => {
  const project = host.requireProject()
  if (expected !== undefined && (typeof expected !== 'string' || path.resolve(expected).toLowerCase() !== path.resolve(project.path).toLowerCase())) throw new Error('FTB request belongs to a different project')
  return { ...project }
}
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
diagnosticHandle('modpack:readFtbQuestBook', (_event, projectPath: unknown) => readFtbQuestBook(ftbProject(projectPath)));
diagnosticHandle('modpack:listFtbQuestBackups', (_event, projectPath: unknown) => listFtbQuestBackups(ftbProject(projectPath)));
diagnosticHandle('modpack:restoreFtbQuestBackup', (_event, projectPath: unknown, id: unknown, baseline: unknown) => {
    if (typeof id !== 'string' || typeof baseline !== 'string')
        throw new Error('Invalid backup request');
    return restoreFtbQuestBackup(ftbProject(projectPath), id, baseline);
});
diagnosticHandle('modpack:ftbQuestIcon', (_event, input: unknown, projectPath: unknown) => resolveFtbQuestIcon(ftbProject(projectPath), input));
diagnosticHandle('modpack:inspectFtbQuestIcon', (_event, input: unknown, projectPath: unknown, remote: unknown) => inspectFtbQuestIcon(ftbProject(projectPath), input, remote === true));
diagnosticHandle('modpack:refreshFtbQuestResources', (_event, projectPath: unknown, input: unknown) => refreshFtbQuestResources(ftbProject(projectPath), input));
diagnosticHandle('modpack:ftbQuestItemNames', (_event, itemIds: unknown, projectPath: unknown) => resolveFtbQuestItemNames(ftbProject(projectPath), Array.isArray(itemIds) ? itemIds.filter((id): id is string => typeof id === 'string') : []));
diagnosticHandle('modpack:ftbQuestDependencyTexture', (_event, projectPath: unknown) => resolveFtbQuestDependencyTexture(ftbProject(projectPath)));
diagnosticHandle('modpack:ftbQuestShapes', (_event, projectPath: unknown) => resolveFtbQuestShapes(ftbProject(projectPath)));
diagnosticHandle('modpack:saveFtbQuestBook', (_event, input: unknown, projectPath: unknown) => {
    if (!input || typeof input !== 'object')
        throw new Error('invalid FTB Quests book');
    return saveFtbQuestBook(ftbProject(projectPath), input as Parameters<typeof saveFtbQuestBook>[1]);
});
diagnosticHandle('modpack:writeFtbQuest', (_event, input: unknown) => writeFtbQuestChapter(host.requireProject(), input as Parameters<typeof writeFtbQuestChapter>[1]));


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "modpackWriteFtbQuest"> => {
return { modpackWriteFtbQuest: async (input) => {
    if (!isModpackProject(project))
        throw new Error('current project is not a modpack');
    const relative = await writeFtbQuestChapter(project, input as unknown as Parameters<typeof writeFtbQuestChapter>[1]);
    return { success: true, path: relative };
} }
}
actions["modpack_write_ftb_quest"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).modpackWriteFtbQuest!(input)
return { actions, createMcpHandlers, inspectFtbQuestIcon, refreshFtbQuestResources, resolveFtbQuestDependencyTexture, resolveFtbQuestIcon, resolveFtbQuestItemNames, resolveFtbQuestShapes, listFtbQuestBackups, readFtbQuestBook, restoreFtbQuestBackup, saveFtbQuestBook,  }
}
