!include "getProcessInfo.nsh"
!define MODMIND_UPGRADE_HOOK_PATH "${__FILEDIR__}\installer-upgrade-hook.nsh"
Var pid

; Keep electron-builder's process checks, including the uninstaller checks.
!macro customCheckAppRunning
  !insertmacro _CHECK_APP_RUNNING
  ; installUtil.nsh has been expanded by this point. Replace only its call
  ; macro, not the bundled template or signed uninstaller generation.
  !ifndef BUILD_UNINSTALLER
    !include "${MODMIND_UPGRADE_HOOK_PATH}"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Var ModMindUpgradeRoot
Var ModMindUpgradeCommand
Var ModMindUpgradeUninstaller
Var ModMindUpgradeDirectory
Var ModMindUpgradeArguments
Var ModMindUpgradeBackup
Var ModMindUpgradeBackupTarget
Var ModMindUpgradeCommitted
Var ModMindUpgradeLog
Var ModMindUpgradeMessage
Var ModMindUpgradeResult
Var ModMindUpgradeAttempt
Var ModMindUpgradeFinished

!macro ModMindReadUpgradeRegistry OUTPUT KEY VALUE
  ${If} $ModMindUpgradeRoot == "HKEY_CURRENT_USER"
    ReadRegStr ${OUTPUT} HKCU "${KEY}" "${VALUE}"
  ${Else}
    ReadRegStr ${OUTPUT} SHELL_CONTEXT "${KEY}" "${VALUE}"
  ${EndIf}
!macroend

!macro ModMindUpgradeFunctions
Function ModMindLogUpgrade
  Push $0
  Push $1
  ${If} $ModMindUpgradeLog == ""
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $ModMindUpgradeLog "$TEMP\ModMind-install-${VERSION}-$0.log"
  ${EndIf}
  ClearErrors
  FileOpen $0 "$ModMindUpgradeLog" a
  ${IfNot} ${Errors}
    FileSeek $0 0 END $1
    ${If} $1 == 0
      FileWriteWord $0 0xFEFF
    ${EndIf}
    FileWriteUTF16LE $0 "$ModMindUpgradeMessage$\r$\n"
    FileClose $0
  ${EndIf}
  Pop $1
  Pop $0
  ClearErrors
FunctionEnd

Function ModMindUninstallOldVersion
  Pop $ModMindUpgradeRoot
  StrCpy $ModMindUpgradeCommand ""
  !insertmacro ModMindReadUpgradeRegistry $ModMindUpgradeCommand "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $ModMindUpgradeCommand == ""
      !insertmacro ModMindReadUpgradeRegistry $ModMindUpgradeCommand "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${EndIf}
  !endif
  ${If} $ModMindUpgradeCommand == ""
    ; Preserve upstream handling of a fresh installation.
    Push $ModMindUpgradeRoot
    Call uninstallOldVersion
    Return
  ${EndIf}

  Push $ModMindUpgradeCommand
  Call GetInQuotes
  Pop $ModMindUpgradeUninstaller
  !insertmacro ModMindReadUpgradeRegistry $ModMindUpgradeDirectory "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $ModMindUpgradeDirectory == ""
  ${AndIf} $ModMindUpgradeUninstaller != ""
    Push $ModMindUpgradeUninstaller
    Call GetFileParent
    Pop $ModMindUpgradeDirectory
  ${EndIf}
  ${If} $ModMindUpgradeDirectory == ""
    StrCpy $ModMindUpgradeResult "旧版安装记录缺少安装路径"
    Goto unsafe_upgrade
  ${EndIf}
  StrCpy $ModMindUpgradeArguments "/allusers"
  ${If} $installMode == "CurrentUser"
  ${OrIf} $ModMindUpgradeRoot == "HKEY_CURRENT_USER"
    StrCpy $ModMindUpgradeArguments "/currentuser"
  ${EndIf}
  ; Upgrades must never ask an old uninstaller to delete application data.
  StrCpy $ModMindUpgradeArguments "$ModMindUpgradeArguments --updated /KEEP_APP_DATA"
  StrCpy $0 "true"
  !ifdef allowToChangeInstallationDirectory
    ${IfNot} ${isUpdated}
      StrCpy $0 "false"
    ${EndIf}
  !endif
  ${If} $0 == "true"
    !insertmacro ModMindReadUpgradeRegistry $0 "${INSTALL_REGISTRY_KEY}" KeepShortcuts
    ${If} $0 == "true"
    ${AndIf} ${FileExists} "$appExe"
      StrCpy $ModMindUpgradeArguments "$ModMindUpgradeArguments --keep-shortcuts"
    ${EndIf}
  ${EndIf}
  StrCpy $ModMindUpgradeAttempt 0

  retry_uninstall:
  IntOp $ModMindUpgradeAttempt $ModMindUpgradeAttempt + 1
  StrCpy $ModMindUpgradeResult "launch-failed"
  ClearErrors
  CopyFiles /SILENT "$ModMindUpgradeUninstaller" "$PLUGINSDIR\old-uninstaller.exe"
  ${IfNot} ${Errors}
    ClearErrors
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S $ModMindUpgradeArguments _?=$ModMindUpgradeDirectory' $ModMindUpgradeResult
  ${EndIf}
  ${If} ${Errors}
    ClearErrors
    ExecWait '"$ModMindUpgradeUninstaller" /S $ModMindUpgradeArguments _?=$ModMindUpgradeDirectory' $ModMindUpgradeResult
    ${If} ${Errors}
      StrCpy $ModMindUpgradeResult "launch-failed"
    ${EndIf}
  ${EndIf}
  StrCpy $ModMindUpgradeMessage "uninstall attempt=$ModMindUpgradeAttempt result=$ModMindUpgradeResult root=$ModMindUpgradeRoot directory=$ModMindUpgradeDirectory executable=$ModMindUpgradeUninstaller"
  Call ModMindLogUpgrade
  ${If} $ModMindUpgradeResult == 0
    StrCpy $R0 0
    ClearErrors
    Return
  ${EndIf}
  ${If} $ModMindUpgradeAttempt < 2
    Sleep 1000
    Goto retry_uninstall
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "旧版本卸载失败，退出码：$ModMindUpgradeResult。$\r$\n旧目录：$ModMindUpgradeDirectory$\r$\n日志：$ModMindUpgradeLog$\r$\n$\r$\n是否尝试保留旧目录备份后修复安装？仅支持同目录升级。旧目录中的额外文件会保留在备份中。" /SD IDNO IDYES repair_upgrade
  SetErrorLevel 2
  Quit

  repair_upgrade:
  Call ModMindStageUpgradeBackup
  ${If} $ModMindUpgradeResult != 0
    unsafe_upgrade:
    StrCpy $ModMindUpgradeMessage "repair refused reason=$ModMindUpgradeResult directory=$ModMindUpgradeDirectory target=$INSTDIR"
    Call ModMindLogUpgrade
    MessageBox MB_OK|MB_ICONSTOP "无法安全备份旧版本，安装已停止。$\r$\n原因：$ModMindUpgradeResult$\r$\n目录：$ModMindUpgradeDirectory$\r$\n请检查目录权限、文件占用或安全软件拦截。$\r$\n日志：$ModMindUpgradeLog" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R0 0
  ClearErrors
FunctionEnd

Function ModMindStageUpgradeBackup
  StrCpy $ModMindUpgradeResult "安装路径不一致或旧版文件缺失"
  ${If} $ModMindUpgradeBackup != ""
    Return
  ${EndIf}
  ; A secondary per-user uninstall during an all-users migration must not
  ; replace another installation or silently change its ownership/scope.
  ${If} $ModMindUpgradeRoot == "HKEY_CURRENT_USER"
  ${AndIf} $installMode == "all"
    StrCpy $ModMindUpgradeResult "安装范围改变，无法自动修复"
    Return
  ${EndIf}
  ${If} $ModMindUpgradeDirectory == ""
    Return
  ${EndIf}
  GetFullPathName $0 "$ModMindUpgradeDirectory"
  GetFullPathName $1 "$INSTDIR"
  ${If} $0 != $1
    Return
  ${EndIf}
  IfFileExists "$0\${APP_EXECUTABLE_FILENAME}" 0 backup_done
  IfFileExists "$0\resources\app.asar" 0 backup_done
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 == -1
    Return
  ${EndIf}
  IntOp $1 $1 & 0x400
  ${If} $1 != 0
    StrCpy $ModMindUpgradeResult "旧目录是链接，无法自动修复"
    Return
  ${EndIf}
  ; A sibling backup keeps the directory rename on the same filesystem.
  Push $0
  Call GetFileParent
  Pop $1
  ClearErrors
  GetTempFileName $2 "$1"
  ${If} ${Errors}
    StrCpy $ModMindUpgradeResult "无法在旧目录旁创建备份"
    Return
  ${EndIf}
  Delete "$2"
  StrCpy $2 "$2-ModMind-backup"
  SetOutPath "$TEMP"
  ClearErrors
  ; MoveFileW never copies across volumes and reports the actual Win32 error.
  System::Call 'kernel32::MoveFileW(w r0, w r2) i.r1 ?e'
  Pop $3
  ${If} $1 == 0
    StrCpy $ModMindUpgradeResult "目录备份失败，Windows 错误 $3"
  ${Else}
    StrCpy $ModMindUpgradeBackup "$2"
    StrCpy $ModMindUpgradeBackupTarget "$0"
    StrCpy $ModMindUpgradeResult 0
    StrCpy $ModMindUpgradeMessage "repair backup=$ModMindUpgradeBackup target=$ModMindUpgradeBackupTarget"
    Call ModMindLogUpgrade
  ${EndIf}
  backup_done:
FunctionEnd

Function .onGUIEnd
  Call ModMindFinishUpgrade
FunctionEnd

Function .onInstFailed
  Call ModMindFinishUpgrade
FunctionEnd

Function ModMindFinishUpgrade
  ${If} $ModMindUpgradeBackup == ""
    Return
  ${EndIf}
  ${If} $ModMindUpgradeFinished == 1
    Return
  ${EndIf}
  StrCpy $ModMindUpgradeFinished 1
  ${If} $ModMindUpgradeCommitted == 1
    StrCpy $ModMindUpgradeMessage "repair completed; retained backup=$ModMindUpgradeBackup"
    Call ModMindLogUpgrade
    MessageBox MB_OK|MB_ICONINFORMATION "修复安装已完成。旧版目录已保留在：$\r$\n$ModMindUpgradeBackup$\r$\n$\r$\n如旧目录中存放过项目或其他个人文件，可从此处取回。" /SD IDOK
    Return
  ${EndIf}
  ; Preserve partial new files too. Never recursively delete either directory.
  SetOutPath "$TEMP"
  ClearErrors
  IfFileExists "$ModMindUpgradeBackupTarget\*.*" 0 restore_backup
  Rename "$ModMindUpgradeBackupTarget" "$ModMindUpgradeBackup-incomplete"
  IfErrors restore_failed
  restore_backup:
  ClearErrors
  Rename "$ModMindUpgradeBackup" "$ModMindUpgradeBackupTarget"
  IfErrors restore_failed
  StrCpy $ModMindUpgradeMessage "repair cancelled/failed; restored=$ModMindUpgradeBackupTarget partial=$ModMindUpgradeBackup-incomplete"
  Call ModMindLogUpgrade
  Return
  restore_failed:
  StrCpy $ModMindUpgradeMessage "restore failed; old files retained=$ModMindUpgradeBackup target=$ModMindUpgradeBackupTarget"
  Call ModMindLogUpgrade
  MessageBox MB_OK|MB_ICONSTOP "安装未完成，旧版文件仍保留在：$\r$\n$ModMindUpgradeBackup$\r$\n自动恢复目录失败，请保留该备份。$\r$\n日志：$ModMindUpgradeLog" /SD IDOK
  SetErrorLevel 2
FunctionEnd
!macroend
!endif
