import { sameProjectPath } from "../../src/main/projectPath"
import { importItemTexture, listManagedItems, removeManagedItem, saveManagedItem } from "./src/main/itemEditorService"
import { listVanillaItems } from "./src/main/itemCatalogService"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, screen, shell, Tray } from "electron"
import type { ItemEditorSaveInput } from "../../src/shared/itemEditor"
import type { NativeFeatureHost } from '../../src/main/index'
import type { FeaturePluginInvocationContext } from '../../src/shared/featurePlugins'

export function activate(options: { host: NativeFeatureHost }) {
const host = options.host
const actions: Record<string, (input: Record<string, unknown>, context: FeaturePluginInvocationContext) => unknown> = {}
actions.query = input => input.operation === 'catalog' ? listVanillaItems(host.requireProject().minecraftVersion, undefined, app.getPath('userData')) : listManagedItems(host.requireProject())
actions.manage = input => {
  const project = host.requireProject()
  host.assertProjectMutationAllowed(project.path, '编辑物品')
  if (input.operation === 'save') return saveManagedItem(project, input.definition as unknown as ItemEditorSaveInput)
  if (input.operation === 'remove') return removeManagedItem(project, String(input.id), Number(input.revision))
  throw new Error('不支持的物品编辑操作')
}
const diagnosticHandle = (channel: string, handler: (event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown): void => { actions[channel] = (input) => handler(host.event(), ...(input.args as any[])) }
diagnosticHandle('itemEditor:list', async (_event, projectPath: string) => {
    const project = host.requireProject();
    if (typeof projectPath !== 'string' || !sameProjectPath(projectPath, project.path))
        throw new Error('项目已经切换，请重新打开物品编辑器');
    return listManagedItems(project);
});
diagnosticHandle('itemEditor:catalog', async (_event, projectPath: string) => {
    const project = host.requireProject();
    if (typeof projectPath !== 'string' || !sameProjectPath(projectPath, project.path))
        throw new Error('项目已经切换，请重新打开物品编辑器');
    return listVanillaItems(project.minecraftVersion, undefined, app.getPath('userData'));
});
diagnosticHandle('itemEditor:save', async (_event, projectPath: string, input: ItemEditorSaveInput) => {
    const project = host.requireProject();
    if (typeof projectPath !== 'string' || !sameProjectPath(projectPath, project.path))
        throw new Error('项目已经切换，请重新打开物品编辑器');
    return saveManagedItem(project, input);
});
diagnosticHandle('itemEditor:remove', async (_event, projectPath: string, id: string, revision: number) => {
    const project = host.requireProject();
    if (typeof projectPath !== 'string' || !sameProjectPath(projectPath, project.path))
        throw new Error('项目已经切换，请重新打开物品编辑器');
    return removeManagedItem(project, id, revision);
});
diagnosticHandle('itemEditor:importTexture', async (_event, projectPath: string) => {
    const project = host.requireProject();
    if (typeof projectPath !== 'string' || !sameProjectPath(projectPath, project.path))
        throw new Error('项目已经切换，请重新打开物品编辑器');
    const selection = await dialog.showOpenDialog(host.mainWindow!, { title: '导入物品贴图', properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
    if (selection.canceled || !selection.filePaths[0])
        return null;
    if (!sameProjectPath(project.path, host.requireProject().path))
        throw new Error('项目已经切换，请重新导入贴图');
    return importItemTexture(project, selection.filePaths[0]);
});

return { actions, importItemTexture, listManagedItems, removeManagedItem, saveManagedItem, listVanillaItems,  }
}
