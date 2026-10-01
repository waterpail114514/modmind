import { GitService } from "./src/main/gitService"
import type {
  AiAttachment,
  AiAttachmentSelectionKind,
  AiBackendSwitchResult,
  AiOutputEvent,
  AiCreateCodeOptions,
  AiCancellationResult,
  AiProjectTaskState,
  AiRecoveryInfo,
  AiSurface,
  AiModelInfo,
  AiExecutionProfile,
  BeginnerAiPreferences,
  AgentSettings,
  AppVersionCheckResult,
  CodingResult,
  ExistingProjectAdoptInput,
  ExistingProjectAnalysis,
  ExistingProjectInspectionProgress,
  ExternalAgentConfiguration,
  FileNode,
  JavaPreferences,
  ProjectImageAsset,
  GradleInstallation,
  LoaderKind,
  PipelineEvent,
  PreflightResult,
  ProjectCreateInput,
  ProjectInfo,
  ProjectRenameInput,
  ProjectMigrationInput,
  ProjectMigrationPreview,
  ProjectMigrationResult,
  SnapshotInfo,
  SnapshotStorageInfo,
  SnapshotRestoreResult,
  DeviceConnectionState,
  RemoteConnectionState,
  McpBridgeState,
  DeviceUsage,
  DiagnosticPageSnapshot,
  ModpackFileOption,
  ModpackMigrationCreateInput,
  ModpackMigrationCreateResult,
  ModpackMigrationMode,
  ModpackMigrationRecord,
  ModpackMigrationUndoResult,
  ModpackModuleSide,
  ModpackSearchResponse,
  ModpackContentDownloadInput,
  ModpackContentKind,
  ModpackContentScope,
  SidebarViewId,
  DetachedWindowTarget
} from "../../src/shared/types"
import path from "node:path"
import { promises as fs, readFileSync, createReadStream } from "node:fs"
import type { AddonImportSelection, AddonPlatformInstallInput, AddonPrepareInput, AddonRelationshipRole, AudioImportInput, ContentCreateInput, GiteeBuildSettings, GitCommitInput, MavenDependencyInput, ReleasePublishInput, ReleaseSettings, ReleaseSummaryDraft, TestMatrixResult, TestTarget } from "../../src/shared/production"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
actions.query = input => {
  const git = requireGitService()
  if (input.operation === 'diff') return git.diff(typeof input.path === 'string' ? input.path : undefined)
  if (input.operation === 'remotes') return git.listRemotes()
  return git.status()
}
actions.manage = input => {
  const project = host.requireProject()
  host.assertProjectMutationAllowed(project.path, '管理项目版本')
  const git = requireGitService()
  switch (input.operation) {
    case 'initialize': return git.initialize()
    case 'commit': return git.commit(input.commit as import('../../src/shared/production').GitCommitInput)
    case 'createBranch': return git.createBranch(String(input.name))
    case 'fetch': return git.fetch(typeof input.remote === 'string' ? input.remote : undefined)
    case 'pull': return git.pull(typeof input.remote === 'string' ? input.remote : undefined, typeof input.branch === 'string' ? input.branch : undefined)
    case 'push': return git.push(typeof input.remote === 'string' ? input.remote : undefined, typeof input.branch === 'string' ? input.branch : undefined)
    case 'merge': return git.merge(String(input.branch))
    case 'rebase': return git.rebase(String(input.branch))
    default: throw new Error('不支持的版本管理操作')
  }
}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
let gitService: GitService | null = null;
function requireGitService(): GitService {
    if (!gitService)
        gitService = new GitService(host.requireProject);
    return gitService;
}
diagnosticHandle('snapshots:create', async (_event, label: string, projectPath?: string): Promise<SnapshotInfo> => {
    const project = projectPath?.trim() ? await host.readProjectInfo(path.resolve(projectPath)) : host.requireProject();
    if (!project)
        throw new Error('项目不存在或不是有效的 ModMind 项目');
    return host.createProjectSnapshot(label.trim() || '手动快照', {}, project);
});
diagnosticHandle('snapshots:list', async (_event, projectPath?: string): Promise<SnapshotInfo[]> => {
    const project = projectPath?.trim() ? await host.readProjectInfo(path.resolve(projectPath)) : host.requireProject();
    if (!project)
        throw new Error('项目不存在或不是有效的 ModMind 项目');
    const root = path.join(project.path, host.projectDataDirectory(project), 'snapshots');
    if (!(await host.pathExists(root)))
        return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const snapshots: SnapshotInfo[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        try {
            snapshots.push(JSON.parse(await fs.readFile(path.join(root, entry.name, 'snapshot.json'), 'utf8')) as SnapshotInfo);
        }
        catch {
            // Ignore incomplete snapshots.
        }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});
diagnosticHandle('snapshots:storage', async (_event, projectPath?: string) => {
    const project = projectPath?.trim() ? await host.readProjectInfo(path.resolve(projectPath)) : host.requireProject();
    if (!project)
        throw new Error('项目不存在或不是有效的 ModMind 项目');
    return host.readSnapshotStorage(project.path);
});
diagnosticHandle('snapshots:restore', (_event, id: string, projectPath?: string): Promise<SnapshotRestoreResult> => host.restoreProjectSnapshot(id, projectPath));
diagnosticHandle('snapshots:delete', (_event, id: string, projectPath?: string): Promise<SnapshotInfo[]> => host.deleteProjectSnapshot(id, projectPath));
diagnosticHandle('git:status', () => requireGitService().status());
diagnosticHandle('git:initialize', () => requireGitService().initialize());
diagnosticHandle('git:diff', (_event, relativePath?: string) => requireGitService().diff(relativePath));
diagnosticHandle('git:commit', (_event, input: GitCommitInput) => requireGitService().commit(input));
diagnosticHandle('git:createBranch', (_event, name: string) => requireGitService().createBranch(name));
diagnosticHandle('git:listRemotes', () => requireGitService().listRemotes());
diagnosticHandle('git:addRemote', (_event, name: string, url: string) => requireGitService().addRemote(name, url));
diagnosticHandle('git:removeRemote', (_event, name: string) => requireGitService().removeRemote(name));
diagnosticHandle('git:fetch', (_event, remote?: string) => requireGitService().fetch(remote));
diagnosticHandle('git:pull', (_event, remote?: string, branch?: string) => requireGitService().pull(remote, branch));
diagnosticHandle('git:push', (_event, remote?: string, branch?: string) => requireGitService().push(remote, branch));
diagnosticHandle('git:merge', (_event, branch: string) => requireGitService().merge(branch));
diagnosticHandle('git:rebase', (_event, branch: string) => requireGitService().rebase(branch));
diagnosticHandle('git:pullRequestUrl', async (_event, remote?: string) => {
    const url = await requireGitService().pullRequestUrl(remote);
    await shell.openExternal(url);
    return url;
});

return { actions, requireGitService, GitService,  }
}
