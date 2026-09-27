; CHECK_APP_RUNNING is expanded after installUtil.nsh and before the calls
; to uninstallOldVersion in electron-builder 25.1.8's installSection.nsh.
!ifndef MODMIND_UPGRADE_HOOK
!define MODMIND_UPGRADE_HOOK
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  Push "${ROOT_KEY}"
  Call ModMindUninstallOldVersion
!macroend
!endif
