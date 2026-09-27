!include "nsDialogs.nsh"
!include "${__FILEDIR__}\installer-upgrade.nsh"

!ifndef BUILD_UNINSTALLER

Var DesktopShortcutCheckbox
Var CreateDesktopShortcut
Var PersonalDesktopPath

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 ModMind"
  !define MUI_WELCOMEPAGE_TEXT "ModMind 是面向 Minecraft 创作的 AI 开发工作台。$\r$\n$\r$\n安装程序将引导你选择使用范围、安装位置和个人桌面快捷方式。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function StartModMind
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "ModMind 已准备就绪"
  !define MUI_FINISHPAGE_TEXT "安装已经完成。现在可以开始创建、接管和测试 Minecraft 项目。"
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 ModMind"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartModMind"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
  BrandingText "ModMind · Minecraft 创作工作台"
  !ifndef BUILD_UNINSTALLER
    !insertmacro ModMindUpgradeFunctions
  !endif
!macroend

!macro customInit
  StrCpy $CreateDesktopShortcut ${BST_CHECKED}
  SetShellVarContext current
  StrCpy $PersonalDesktopPath "$DESKTOP"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPageCreate
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:个人桌面快捷方式"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:选择是否在当前用户真正使用的桌面上创建入口。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 8u 100% 24u "安装程序会使用 Windows 返回的个人桌面路径，包括 OneDrive 或其他重定向桌面。"
  Pop $0

  ${NSD_CreateCheckbox} 0 48u 100% 14u "在个人桌面上创建 ModMind 快捷方式"
  Pop $DesktopShortcutCheckbox
  ${NSD_SetState} $DesktopShortcutCheckbox $CreateDesktopShortcut

  ${NSD_CreateLabel} 18u 68u 92% 24u "目标位置：$PersonalDesktopPath"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcut
FunctionEnd

!macro customInstall
  ${If} $installMode == "all"
    SetShellVarContext all
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    SetShellVarContext current
  ${EndIf}

  StrCpy $newDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${If} $CreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  StrCpy $ModMindUpgradeCommitted 1
!macroend

!endif

!macro customUnInstall
  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}

  StrCpy $0 "$DESKTOP\${SHORTCUT_NAME}.lnk"
  WinShell::UninstShortcut "$0"
  Delete "$0"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend
