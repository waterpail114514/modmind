# Windows 升级卸载失败补丁

`installer.nsh` 引入 `installer-upgrade.nsh`。当前适配 electron-builder 26.15.3，并保留 25.1.8 的宏兼容。

26.x 的默认进程检查会先展开 `IS_POWERSHELL_AVAILABLE`，再展开
`_CHECK_APP_RUNNING`；使用 `customCheckAppRunning` 时需要在自定义宏中
补上这一步。补丁按宏是否存在调用该初始化，确保安装器和卸载器均声明、
设置 `$IsPowerShellAvailable`，旧模板没有该宏时继续使用原检查流程。

上游 `uninstallOldVersion` 连续失败后会反复显示“ModMind 无法关闭”，且
`customUnInstallCheck` 扩展点在这个弹窗之后才执行。因此在
`customCheckAppRunning` **编译展开时**，通过 `installer-upgrade-hook.nsh`
替换随后的 `uninstallOldVersion` 宏调用。仍运行原来的进程检查，且保留
electron-builder 的卸载器生成和签名流程；不修改 `node_modules`。

行为：

- 正常执行旧版卸载器，保留 `--updated`、`/KEEP_APP_DATA` 和快捷方式参数。
- 至多自动尝试两次；失败后显示实际退出码、旧目录和日志位置。
- 用户可选择修复：仅对同目录、同范围的现有应用，将旧目录改名到同盘的
  `*-ModMind-backup`，再安装新文件。目录链接、范围迁移、目录不同或缺失
  应用标记时拒绝修复。文件仍被锁定或权限不足时停止，不强行覆盖。
- 静默安装默认拒绝修复并返回非零退出码，不把失败当成安装成功。
- 安装器报告失败或界面退出而未完成时，尝试恢复旧目录；不完整的新目录
  保留为 `*-ModMind-backup-incomplete`。成功后也保留旧目录并告知用户位置。
- 日志为 UTF-16LE，位于 `%TEMP%\ModMind-install-<version>-<pid>.log`。

修复不删除任何备份或个人文件，也不修改 AppData。断电、强杀安装器，或旧
卸载器自己已损坏文件的情况不能保证自动恢复；备份目录需保留以便人工处理。
此补丁不能绕过安全软件、文件独占锁或目录权限，也未确认反馈用户的实际根因。

验证（Windows，使用 electron-builder 缓存中的 NSIS；可用
`MODMIND_MAKENSIS` 指定编译器）：

```powershell
node scripts/installer-upgrade-smoke.mjs
npx electron-builder --win --prepackaged release/win-unpacked --config.directories.output=test-results/installer-upgrade-build --config.forceCodeSigning=false --publish never
```

隔离测试运行实际 NSIS 程序，覆盖新装、成功卸载、失败/缺失卸载器、有限重试、
参数和日志、目录备份与恢复、未完成文件保留、安装范围/目录变化、目录链接、
独占文件锁。只写临时目录和唯一的 `HKCU\Software\ModMindInstallerSmokeTest`
子键，结束时清除测试键。完整安装包编译使用默认 warnings-as-errors，验证宏
插入位置；升级 electron-builder 后必须重跑。

2026-10-14 补齐 PowerShell 初始化后，14 个隔离场景全部通过；实际运行
`build-unsigned.bat` 并输入 `1.4.20`，BAT 完成并退出 0。安装器与卸载器
使用默认 warnings-as-errors 编译成功，随后包内更新配置、三份 Gradle Wrapper
及更新文件准备均通过。产物为 `release/ModMind Setup 1.4.20.exe`，
更新文件位于 `release/update`。

上述命令产生的是未签名的本地验证包。正式发布仍走项目现有签名发布流程。
