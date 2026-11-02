import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { requestAiTextResponse } from '../../src/main/aiTextRequest'

import { ContentService } from "./src/main/contentService"
import { ReleaseService, type ReleaseSecrets } from "./src/main/releaseService"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import type { AddonImportSelection, AddonPlatformInstallInput, AddonPrepareInput, AddonRelationshipRole, AudioImportInput, ContentCreateInput, GiteeBuildSettings, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, ReleaseSummaryDraft, TestMatrixResult, TestTarget } from "../../src/shared/production"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
function parseReleaseSummary(content: string, fallback: ReleaseSummaryDraft): ReleaseSummaryDraft {
    const candidate = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
    try {
        const value = JSON.parse(candidate) as Record<string, unknown>;
        const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 500) : '';
        const changelog = typeof value.changelog === 'string' ? value.changelog.trim().slice(0, 100000) : '';
        if (summary)
            return { summary, changelog: changelog || fallback.changelog, generatedBy: 'ai' };
    }
    catch { /* A non-JSON response falls back to the deterministic draft. */ }
    return fallback;
}
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "publishing" }, () => handler(host.event(), ...(input.args as any[]))) }
let contentService: ContentService | null = null;
let releaseService: ReleaseService | null = null;
function requireContentService(): ContentService {
    if (!contentService)
        contentService = new ContentService(host.requireProject);
    return contentService;
}
function requireReleaseService(): ReleaseService {
    if (!releaseService)
        releaseService = new ReleaseService(host.requireProject, host.readReleaseSecrets, host.writeReleaseSecrets, app.getVersion());
    return releaseService;
}
async function generateAiReleaseSummary(): Promise<ReleaseSummaryDraft> {
  const project = host.requireProject()
  const fallback = await requireReleaseService().suggestSummary()
  const settings = await host.readSettings()
  const backend = settings.codingBackend
  const config = await host.getAiReviewerConfig(backend === 'quota', backend === 'quota' ? 'codex' : backend, settings).catch(() => null)
  if (!config?.baseUrl || !config.apiKey || !config.model) return fallback
  const response = await requestAiTextResponse({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }, [
        { role: 'system', content: 'You write concise Minecraft release notes in Simplified Chinese. Return only JSON with string fields summary and changelog. Do not claim unverified gameplay changes.' },
        { role: 'user', content: `Create a release summary from this local metadata. Do not request files or make edits.\n${JSON.stringify({ project: project.name, minecraft: project.minecraftVersion, loader: project.loader, fallback }, null, 2)}` }
      ], { temperature: 0.25, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) return fallback
  const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }> } | null
  const content = typeof body?.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : ''
  return content ? parseReleaseSummary(content, fallback) : fallback
}
diagnosticHandle('content:create', (_event, input: ContentCreateInput) => requireContentService().create(input));
diagnosticHandle('content:importAudio', async (_event, input: AudioImportInput) => {
    const result = await dialog.showOpenDialog(host.mainWindow!, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'flac', 'm4a'] }] });
    if (result.canceled || !result.filePaths[0])
        return null;
    return requireContentService().importAudio(result.filePaths[0], input);
});
diagnosticHandle('content:validate', () => requireContentService().validate());
diagnosticHandle('release:getSettings', () => requireReleaseService().getSettings());
diagnosticHandle('release:saveSettings', async (_event, settings: ReleaseSettings) => {
    const saved = await requireReleaseService().saveSettings(settings);
    const providerSecrets = await host.readReleaseSecrets();
    host.curseForgeProviderKey = providerSecrets.curseForgeToken || process.env.MODMIND_CURSEFORGE_API_KEY || '$2a$10$BB17.sSejQebcTN01XAqmeXbucdfzq/nIKXylaKLpQHtHLrREVPku';
    host.modProviderRegistry = null;
    return saved;
});
diagnosticHandle('release:prepareExport', () => requireReleaseService().prepareExport());
diagnosticHandle('release:markExported', () => requireReleaseService().markExported());
diagnosticHandle('release:suggestSummary', () => generateAiReleaseSummary());
diagnosticHandle('release:preflight', () => requireReleaseService().preflight());
diagnosticHandle('release:publish', (_event, input: ReleasePublishInput) => host.runDiagnosticOperation('release', 'publish', 'Project release', () => requireReleaseService().publish(input), { targets: input.targets }));


const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "contentValidate" | "releasePreflight"> => {
return { contentValidate: () => requireContentService().validate(),
releasePreflight: () => requireReleaseService().preflight() }
}
actions["content_validate"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).contentValidate!()
actions["release_preflight"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).releasePreflight!()
actions["modpack_export"] = (input, context) => {
  context.signal?.throwIfAborted()
  const project = host.requireProject()
  return requireReleaseService().exportModpack(input, project)
}
return { actions, parseReleaseSummary, createMcpHandlers, requireContentService, requireReleaseService, generateAiReleaseSummary, ContentService, ReleaseService,  }
}
