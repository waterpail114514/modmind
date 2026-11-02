import { diagnosticIpcOperations } from '../../src/main/diagnosticOperations'
import { diagnosticArguments } from '../../src/main/diagnosticContext'
import { BlockbenchBridge } from "./src/main/blockbenchBridge"
import path from 'node:path'
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
import { sameProjectPath } from "../../src/main/projectPath"
import type { BlockbenchAction, BlockbenchAssetMetadata, BlockbenchAssetSaveRequest, BlockbenchBounds, BlockbenchCaptureRequest, BlockbenchCommand } from "../../src/shared/blockbench"
import { compileAssetIntent } from "./src/main/assetIntentCompiler"
import { compileAssetRefinement } from "./src/main/assetRefinementCompiler"
import type {AdvancedAssetCandidate, AdvancedAssetCandidatePreview, AdvancedAssetComparison, AdvancedAssetPreviewOptions, AdvancedAssetProgram, ReferenceImageAssetProgram} from "../../src/shared/advancedAsset"
import {compileAdvancedAsset, compileAdvancedAssetVariants, optimizeAdvancedProgram} from "./src/main/advancedAssetCompiler"
import {reviewAssetCaptures} from "./src/main/assetVisualReview"
import {describeBlockbenchActions} from "./src/main/blockbenchDiff"
import {compileReferenceImageAsset} from "./src/main/referenceImageAssetCompiler"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import { readYsmSource } from "./src/main/modelSourceService"
import { normalizeThemePreset, normalizeAppearance, normalizeCustomThemeColors } from "../../src/shared/appTheme"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost; pluginDirectory?: string }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input, context) => diagnosticIpcOperations.run('feature-ipc', channel, { input: diagnosticArguments(channel, input.args as unknown[]), projectPath: context.projectPath, pluginId: "model-studio" }, () => handler(host.event(), ...(input.args as any[]))) }
const bridges = new Map<number, { bridge: BlockbenchBridge; window: BrowserWindow; closed: () => void }>()
function disposeBridges(): void {
    for (const { bridge, window, closed } of bridges.values()) { window.removeListener('closed', closed); bridge.destroy() }
    bridges.clear()
}
function requireBlockbench(): BlockbenchBridge {
    const window = host.mainWindow
    if (!window || window.isDestroyed()) throw new Error('模型工作台窗口不可用')
    const existing = bridges.get(window.id)
    if (existing) return existing.bridge
    const bridge = new BlockbenchBridge({ window, entryPath: path.join(options.pluginDirectory ?? path.join(app.getAppPath(), 'feature-plugins', 'model-studio'), 'assets', 'blockbench', 'index.html'), getProjectRoot: () => host.currentProject?.path ?? null })
    const closed = () => { if (bridges.get(window.id)?.bridge === bridge) { bridges.delete(window.id); bridge.destroy() } }
    bridges.set(window.id, { bridge, window, closed })
    window.once('closed', closed)
    bridge.onStatus(status => { if (!window.isDestroyed()) window.webContents.send('blockbench:state', { ...status, status: status.phase, connected: status.phase === 'ready' }) })
    void bridge.load().catch(error => { if (!window.isDestroyed()) window.webContents.send('blockbench:state', { status: 'error', connected: false, message: String(error) }) })
    return bridge
}
function requireBlockbenchForProject(project: ProjectInfo): BlockbenchBridge {
    if (!host.currentProject || !sameProjectPath(host.currentProject.path, project.path)) {
        throw new Error('Blockbench 当前属于另一个前台项目；请切回任务项目后重试该操作');
    }
    return requireBlockbench();
}
async function previewAssetIntentCandidate(bridge: BlockbenchBridge, input: unknown, capture: BlockbenchCaptureRequest = {}, signal?: AbortSignal, expectedRevision?: string): Promise<unknown> {
    const candidate = compileAssetIntent(input);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision);
    return {
        ...candidate,
        execution: preview.execution,
        validation: preview.validation,
        ...preview.capture
    };
}
async function compileAssetRefinementForBridge(bridge: BlockbenchBridge, input: unknown): Promise<ReturnType<typeof compileAssetRefinement>> {
    return compileAssetRefinement(input, await bridge.getProjectState());
}
async function previewAssetRefinementCandidate(bridge: BlockbenchBridge, input: unknown, capture: BlockbenchCaptureRequest = {}, signal?: AbortSignal, expectedRevision?: string): Promise<unknown> {
    const candidate = await compileAssetRefinementForBridge(bridge, input);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    if (expectedRevision && candidate.baseRevision !== expectedRevision)
        throw new Error(`Blockbench project changed since the refinement was requested (expected ${expectedRevision}, current ${candidate.baseRevision})`);
    const preview = await bridge.previewRefinementActions(candidate.actions, capture, signal, candidate.baseRevision);
    return {
        ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
        baselineCaptures: preview.baselineCapture.captures, diff: preview.diff
    };
}
async function applyAssetRefinementCandidate(bridge: BlockbenchBridge, input: unknown, signal?: AbortSignal, expectedRevision?: string): Promise<unknown> {
    const candidate = await compileAssetRefinementForBridge(bridge, input);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    if (expectedRevision && candidate.baseRevision !== expectedRevision) {
        throw new Error(`Blockbench project changed since the refinement was requested (expected ${expectedRevision}, current ${candidate.baseRevision})`);
    }
    const execution = await bridge.executeActions(candidate.actions, signal, candidate.baseRevision);
    return { ...candidate, execution };
}
async function previewAdvancedAssetComparison(bridge: BlockbenchBridge, input: unknown, capture: BlockbenchCaptureRequest = {}, options: AdvancedAssetPreviewOptions = {}, signal?: AbortSignal, expectedRevision?: string): Promise<AdvancedAssetComparison> {
    const maxIterations = Math.max(1, Math.min(3, Number(options.maxIterations ?? 3)));
    const targetScore = Math.max(0, Math.min(100, Number(options.targetScore ?? 82)));
    const compiled = compileAdvancedAssetVariants(input);
    const errors = compiled.flatMap((candidate) => candidate.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'));
    if (errors.length)
        throw new Error(errors.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; '));
    const previews: AdvancedAssetCandidatePreview[] = [];
    for (const original of compiled) {
        let current = original;
        let best = await previewAdvancedCandidate(bridge, current, capture, 1, signal, expectedRevision);
        for (let iteration = 2; iteration <= maxIterations && best.review.score < targetScore; iteration += 1) {
            const mode = best.review.metrics.contrast < 0.25
                ? 'contrast'
                : best.review.metrics.occupancy < 0.18
                    ? 'occupancy-up'
                    : 'occupancy-down';
            const optimizedProgram = optimizeAdvancedProgram(current.program, mode);
            const optimized = compileAdvancedAsset(optimizedProgram);
            current = { ...optimized, variantId: original.variantId, label: original.label };
            const preview = await previewAdvancedCandidate(bridge, current, capture, iteration, signal, expectedRevision);
            if (preview.review.score > best.review.score)
                best = preview;
        }
        previews.push(best);
    }
    previews.sort((left, right) => right.review.score - left.review.score);
    return { comparisonVersion: 1, selectedCandidateId: previews[0].variantId, candidates: previews };
}
async function previewAdvancedCandidate(bridge: BlockbenchBridge, candidate: AdvancedAssetCandidate, capture: BlockbenchCaptureRequest, iteration: number, signal?: AbortSignal, expectedRevision?: string): Promise<AdvancedAssetCandidatePreview> {
    const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision);
    const review = await reviewAssetCaptures(preview.capture.captures);
    return {
        ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
        review, iteration, actionDiff: describeBlockbenchActions(candidate.actions)
    };
}
async function previewReferenceImageCandidate(bridge: BlockbenchBridge, input: unknown, capture: BlockbenchCaptureRequest = {}, signal?: AbortSignal, expectedRevision?: string): Promise<AdvancedAssetCandidatePreview & {
    reference: Awaited<ReturnType<typeof compileReferenceImageAsset>>['reference'];
}> {
    const candidate = await compileReferenceImageAsset(input);
    const preview = await bridge.previewCandidateActions(candidate.actions, capture, signal, expectedRevision);
    const review = await reviewAssetCaptures(preview.capture.captures);
    return {
        ...candidate, execution: preview.execution, validation: preview.validation, ...preview.capture,
        review, iteration: 1, actionDiff: describeBlockbenchActions(candidate.actions)
    };
}
diagnosticHandle('blockbench:show', (_event, bounds: BlockbenchBounds) => {
    const bridge = requireBlockbench();
    bridge.setBounds(bounds);
    bridge.show();
});
diagnosticHandle('blockbench:hide', () => { const window = host.mainWindow; if (window) bridges.get(window.id)?.bridge.hide() });
diagnosticHandle('blockbench:getState', () => {
    const status = requireBlockbench().getStatus();
    return { ...status, status: status.phase, connected: status.phase === 'ready' };
});
diagnosticHandle('blockbench:openProject', () => requireBlockbench().executeAction({ type: 'run-command', command: 'open-project' }));
diagnosticHandle('blockbench:openYsm', async () => {
    const project = host.requireProject();
    if (host.runsForProject(project.path).length)
        throw new Error('项目正在执行任务，请稍后打开模型');
    const result = await dialog.showOpenDialog(host.mainWindow!, { title: '打开 YSM 源模型（ysm.json 或未加密 ZIP）', properties: ['openFile'], filters: [{ name: 'YSM 模型源文件', extensions: ['json', 'zip', 'ysm'] }] });
    if (result.canceled || !result.filePaths[0])
        return null;
    const document = await readYsmSource(result.filePaths[0]);
    if (host.requireProject().path !== project.path || host.runsForProject(project.path).length)
        throw new Error('项目状态已改变，请重新打开模型');
    await requireBlockbenchForProject(project).loadSourceDocument(document);
    return { name: document.name, animations: document.animations.length };
});
diagnosticHandle('blockbench:saveProject', () => requireBlockbench().executeAction({ type: 'run-command', command: 'save-project-dialog' }));
diagnosticHandle('blockbench:setTheme', (_event, theme: 'light' | 'dark', preset: unknown, custom: unknown) => requireBlockbench().setTheme(theme, normalizeThemePreset(preset), normalizeCustomThemeColors(custom)));
diagnosticHandle('blockbench:runAction', (_event, action: string) => {
    const mapping: Record<string, BlockbenchCommand> = {
        undo: 'undo',
        redo: 'redo',
        frame_all: 'frame-all',
        toggle_grid: 'toggle-grid',
        toggle_animate: 'toggle-animate',
        mode_edit: 'mode-edit',
        mode_paint: 'mode-paint',
        mode_animate: 'mode-animate'
    };
    const command = mapping[action];
    if (!command)
        throw new Error('Unsupported Blockbench toolbar action');
    return requireBlockbench().executeAction({ type: 'run-command', command });
});
diagnosticHandle('blockbench:execute', (_event, action: BlockbenchAction) => requireBlockbench().executeAction(action));
diagnosticHandle('blockbench:executeActions', (_event, actions: BlockbenchAction[], expectedRevision?: string) => requireBlockbench().executeActions(actions, undefined, expectedRevision));
diagnosticHandle('blockbench:projectState', () => requireBlockbench().getProjectState());
diagnosticHandle('blockbench:validate', () => requireBlockbench().validateProject());
diagnosticHandle('blockbench:captureViews', (_event, request: BlockbenchCaptureRequest) => requireBlockbench().captureViews(request));
diagnosticHandle('blockbench:setAssetMetadata', (_event, metadata: BlockbenchAssetMetadata) => requireBlockbench().setAssetMetadata(metadata));
diagnosticHandle('blockbench:saveAssetBundle', (_event, request: BlockbenchAssetSaveRequest) => requireBlockbench().saveAssetBundle(request));
diagnosticHandle('blockbench:history', () => requireBlockbench().listHistory());
diagnosticHandle('blockbench:createCheckpoint', (_event, label?: string) => requireBlockbench().createCheckpoint(label));
diagnosticHandle('blockbench:restoreHistory', (_event, id: string) => requireBlockbench().restoreHistory(id));
diagnosticHandle('asset-intent:compile', (_event, intent: unknown) => compileAssetIntent(intent));
diagnosticHandle('asset-intent:preview', (_event, intent: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) => previewAssetIntentCandidate(requireBlockbench(), intent, request, undefined, expectedRevision));
diagnosticHandle('asset-intent:apply', async (_event, intent: unknown, expectedRevision?: string) => {
    const candidate = compileAssetIntent(intent);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision);
    return { ...candidate, execution };
});
diagnosticHandle('asset-refinement:compile', async (_event, refinement: unknown) => compileAssetRefinementForBridge(requireBlockbench(), refinement));
diagnosticHandle('asset-refinement:preview', (_event, refinement: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) => previewAssetRefinementCandidate(requireBlockbench(), refinement, request, undefined, expectedRevision));
diagnosticHandle('asset-refinement:apply', async (_event, refinement: unknown, expectedRevision?: string) => {
    return applyAssetRefinementCandidate(requireBlockbench(), refinement, undefined, expectedRevision);
});
diagnosticHandle('advanced-asset:compile', (_event, program: unknown, variantId = 'base') => compileAdvancedAsset(program, variantId));
diagnosticHandle('advanced-asset:preview', (_event, program: unknown, request: BlockbenchCaptureRequest, options: AdvancedAssetPreviewOptions, expectedRevision?: string) => previewAdvancedAssetComparison(requireBlockbench(), program, request, options, undefined, expectedRevision));
diagnosticHandle('advanced-asset:apply', async (_event, program: unknown, variantId = 'base', expectedRevision?: string) => {
    const candidate = compileAdvancedAsset(program, variantId);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision);
    return { ...candidate, execution };
});
diagnosticHandle('reference-asset:compile', (_event, program: unknown) => compileReferenceImageAsset(program));
diagnosticHandle('reference-asset:preview', (_event, program: unknown, request: BlockbenchCaptureRequest, expectedRevision?: string) => previewReferenceImageCandidate(requireBlockbench(), program, request, undefined, expectedRevision));
diagnosticHandle('reference-asset:apply', async (_event, program: unknown, expectedRevision?: string) => {
    const candidate = await compileReferenceImageAsset(program);
    const execution = await requireBlockbench().executeCandidateActions(candidate.actions, undefined, expectedRevision);
    return { ...candidate, execution };
});
diagnosticHandle('asset-visual-review:current', async (_event, request: BlockbenchCaptureRequest) => {
    const capture = await requireBlockbench().captureViews(request);
    return { ...capture, review: await reviewAssetCaptures(capture.captures) };
});

const createMcpHandlers = (project: import('../../src/shared/types').ProjectInfo, signal = new AbortController().signal): Pick<import('../../src/main/externalAgents').ExternalAgentBridgeHandlers, "blockbenchActions" | "blockbenchProjectState" | "blockbenchValidate" | "blockbenchCaptureViews" | "blockbenchHistory" | "blockbenchCheckpoint" | "blockbenchRestoreHistory" | "assetCompileIntent" | "assetPreviewIntent" | "assetApplyIntent" | "assetCompileRefinement" | "assetPreviewRefinement" | "assetApplyRefinement" | "assetCompileAdvanced" | "assetPreviewAdvanced" | "assetApplyAdvanced" | "assetCompileReference" | "assetPreviewReference" | "assetApplyReference" | "assetVisualReview"> => {
return { blockbenchActions: (actions, expectedRevision) => requireBlockbenchForProject(project).executeActions(actions as BlockbenchAction[], signal, expectedRevision),
blockbenchProjectState: () => requireBlockbenchForProject(project).getProjectState(),
blockbenchValidate: () => requireBlockbenchForProject(project).validateProject(),
blockbenchCaptureViews: (input) => requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest),
blockbenchHistory: () => requireBlockbenchForProject(project).listHistory(),
blockbenchCheckpoint: (label) => requireBlockbenchForProject(project).createCheckpoint(label),
blockbenchRestoreHistory: (id) => requireBlockbenchForProject(project).restoreHistory(id),
assetCompileIntent: async (input) => compileAssetIntent(input),
assetPreviewIntent: (input, capture, expectedRevision) => previewAssetIntentCandidate(requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision),
assetApplyIntent: async (input, expectedRevision) => {
    const candidate = compileAssetIntent(input);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision);
    return { ...candidate, execution };
},
assetCompileRefinement: (input) => compileAssetRefinementForBridge(requireBlockbenchForProject(project), input),
assetPreviewRefinement: (input, capture, expectedRevision) => previewAssetRefinementCandidate(requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision),
assetApplyRefinement: (input, expectedRevision) => applyAssetRefinementCandidate(requireBlockbenchForProject(project), input, signal, expectedRevision),
assetCompileAdvanced: async (input, variantId) => compileAdvancedAsset(input, variantId),
assetPreviewAdvanced: (input, capture, options, expectedRevision) => previewAdvancedAssetComparison(requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, options as AdvancedAssetPreviewOptions | undefined, signal, expectedRevision),
assetApplyAdvanced: async (input, variantId, expectedRevision) => {
    const candidate = compileAdvancedAsset(input, variantId);
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        return candidate;
    const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision);
    return { ...candidate, execution };
},
assetCompileReference: (input) => compileReferenceImageAsset(input),
assetPreviewReference: (input, capture, expectedRevision) => previewReferenceImageCandidate(requireBlockbenchForProject(project), input, capture as BlockbenchCaptureRequest | undefined, signal, expectedRevision),
assetApplyReference: async (input, expectedRevision) => {
    const candidate = await compileReferenceImageAsset(input);
    const execution = await requireBlockbenchForProject(project).executeCandidateActions(candidate.actions, signal, expectedRevision);
    return { ...candidate, execution };
},
assetVisualReview: async (input) => {
    const captures = await requireBlockbenchForProject(project).captureViews(input as unknown as BlockbenchCaptureRequest);
    return { ...captures, review: await reviewAssetCaptures(captures.captures, input.referenceHeightToWidth as number | undefined) };
} }
}
actions["blockbench_project_state"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchProjectState!()
actions["blockbench_validate"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchValidate!()
actions["blockbench_capture_views"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchCaptureViews!(input)
actions["blockbench_actions"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchActions!(Array.isArray(input.actions) ? input.actions : [], typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["blockbench_history"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchHistory!()
actions["blockbench_checkpoint"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchCheckpoint!(typeof input.label === 'string' ? input.label : undefined)
actions["blockbench_restore_history"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).blockbenchRestoreHistory!(String(input.id ?? ''))
actions["asset_compile_intent"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetCompileIntent!(input)
actions["asset_preview_intent"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetPreviewIntent!((input.intent && typeof input.intent === 'object' ? input.intent : input) as Record<string, unknown>, input.capture && typeof input.capture === 'object' ? input.capture as Record<string, unknown> : undefined, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_apply_intent"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetApplyIntent!((input.intent && typeof input.intent === 'object' ? input.intent : input) as Record<string, unknown>, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_compile_refinement"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetCompileRefinement!(input)
actions["asset_preview_refinement"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetPreviewRefinement!((input.refinement && typeof input.refinement === 'object' ? input.refinement : input) as Record<string, unknown>, input.capture && typeof input.capture === 'object' ? input.capture as Record<string, unknown> : undefined, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_apply_refinement"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetApplyRefinement!((input.refinement && typeof input.refinement === 'object' ? input.refinement : input) as Record<string, unknown>, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_compile_advanced"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetCompileAdvanced!(input.program ?? input, typeof input.variantId === 'string' ? input.variantId : undefined)
actions["asset_preview_advanced"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetPreviewAdvanced!((input.program && typeof input.program === 'object' ? input.program : input) as Record<string, unknown>, input.capture && typeof input.capture === 'object' ? input.capture as Record<string, unknown> : undefined, input.options && typeof input.options === 'object' ? input.options as Record<string, unknown> : undefined, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_apply_advanced"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetApplyAdvanced!((input.program && typeof input.program === 'object' ? input.program : input) as Record<string, unknown>, typeof input.variantId === 'string' ? input.variantId : undefined, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_compile_reference"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetCompileReference!(input.program ?? input)
actions["asset_preview_reference"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetPreviewReference!((input.program && typeof input.program === 'object' ? input.program : input) as Record<string, unknown>, input.capture && typeof input.capture === 'object' ? input.capture as Record<string, unknown> : undefined, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_apply_reference"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetApplyReference!((input.program && typeof input.program === 'object' ? input.program : input) as Record<string, unknown>, typeof input.expectedRevision === 'string' ? input.expectedRevision : undefined)
actions["asset_visual_review"] = (input, context) => createMcpHandlers(host.requireProject(), context.signal).assetVisualReview!(input)
return { actions, createMcpHandlers, requireBlockbench, requireBlockbenchForProject, previewAssetIntentCandidate, compileAssetRefinementForBridge, previewAssetRefinementCandidate, applyAssetRefinementCandidate, previewAdvancedAssetComparison, previewAdvancedCandidate, previewReferenceImageCandidate, BlockbenchBridge, readYsmSource, compileAssetIntent, compileAssetRefinement, compileAdvancedAsset, compileAdvancedAssetVariants, optimizeAdvancedProgram, compileReferenceImageAsset, reviewAssetCaptures, describeBlockbenchActions, dispose: disposeBridges, projectChanged: disposeBridges }
}
