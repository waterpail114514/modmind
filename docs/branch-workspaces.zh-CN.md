# 版本线与发布位置

## 版本与仓库

| 版本线 | 仓库 | 下载 |
| --- | --- | --- |
| 桌面 2.0 预览版 | [modmind](https://github.com/waterpail114514/modmind) | [2.0.0-preview.1](https://github.com/waterpail114514/modmind/releases/tag/2.0.0-preview.1) |
| 桌面 1.4 维护版 | [modmind-1.4](https://github.com/waterpail114514/modmind-1.4) | [最新维护版](https://github.com/waterpail114514/modmind-1.4/releases/latest) |
| Android 独立版 | [modmind-mobile](https://github.com/waterpail114514/modmind-mobile) | [1.0.0-preview.1](https://github.com/waterpail114514/modmind-mobile/releases/tag/1.0.0-preview.1) |

三个仓库保留各自开发历史。Android 独立版源码位于 `android-mobile/`，与桌面仓库中的 `android-twa/` 网页壳不同。

## 本地工作区

原有本地分支与 worktree 保留，避免中断已有开发。

- `main` → `origin/main`（modmind），桌面 2.0 预览系列。
- `1.4` → `legacy/1.4`（modmind-1.4），维护系列。
- `codex/mobile` → `mobile/main`（modmind-mobile），Android 独立版。

不同工作区应独立维护依赖和构建产物。发布附件放 GitHub Releases；不提交本地配置、凭据、密钥、依赖缓存、运行时私有数据或测试临时目录。旧桌面仓库的历史 Release 保留，新的 1.4 维护版从专用仓库下载。
