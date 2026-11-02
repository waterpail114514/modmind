let accountId = "";

export function setCanvasAccount(userId: string) {
  if (!userId) throw new Error("请先登录后再打开画布");
  accountId = userId;
}

export function canvasAccount() {
  if (!accountId) throw new Error("画布账户尚未初始化");
  return accountId;
}

export function canvasStorageKey(name: string) {
  return `modmind:open-canvas:${name}:v1:${canvasAccount()}`;
}
