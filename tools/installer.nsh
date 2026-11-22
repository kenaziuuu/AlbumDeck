!include "nsDialogs.nsh"
!include "${PROJECT_DIR}\tools\installer-relocation.nsh"

# Keep the old default scope. NSIS still handles existing all-users installs.
!macro customInstallMode
  ${If} $hasPerMachineInstallation != "1"
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  Var adInstallMode
  Var adRegisteredDir
  Var adPreviousDir
  Var adSelectedDir
  Var adDesktopChecked
  Var adDesktopCheckbox
  Var adDestinationSafe

  !macro customInit
    Call ADPrepareOptions
    ${If} ${Silent}
      Call ADCheckDestination
      ${If} $adDestinationSafe != "1"
        SetErrorLevel 2
        Quit
      ${EndIf}
      Call ADReconnectSelectedInstallation
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    # Use the native directory page without the stock hook that appends
    # the app name to a custom destination after the user confirms.
    !define MUI_DIRECTORYPAGE_VARIABLE $adSelectedDir
    !define MUI_PAGE_CUSTOMFUNCTION_PRE ADPrepareDirectoryPage
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE ADLeaveDirectoryPage
    !insertmacro MUI_PAGE_DIRECTORY
    Page custom ADShowOptions ADLeaveOptions
  !macroend

  # The templates declare installMode and the MUI control handles before this hook.
  !macro customHeader
  LangString ADOptions ${LANG_ENGLISH} "Installation options"
  LangString ADOptions ${LANG_SIMPCHINESE} "安装选项"
  LangString ADOptions ${LANG_TRADCHINESE} "安裝選項"
  LangString ADConfirm ${LANG_ENGLISH} "Confirm the location and shortcut before installing."
  LangString ADConfirm ${LANG_SIMPCHINESE} "请确认安装位置和桌面快捷方式。"
  LangString ADConfirm ${LANG_TRADCHINESE} "請確認安裝位置和桌面捷徑。"
  LangString ADDestination ${LANG_ENGLISH} "Install location"
  LangString ADDestination ${LANG_SIMPCHINESE} "安装位置"
  LangString ADDestination ${LANG_TRADCHINESE} "安裝位置"
  LangString ADDesktop ${LANG_ENGLISH} "Create a desktop shortcut"
  LangString ADDesktop ${LANG_SIMPCHINESE} "创建桌面快捷方式"
  LangString ADDesktop ${LANG_TRADCHINESE} "建立桌面捷徑"
  LangString ADUnsafeDir ${LANG_ENGLISH} "Choose a new or empty folder, or the existing AlbumDeck installation folder."
  LangString ADUnsafeDir ${LANG_SIMPCHINESE} "请选择新建或空的文件夹，或已有的唱片台安装目录。"
  LangString ADUnsafeDir ${LANG_TRADCHINESE} "請選擇新建或空白資料夾，或現有的唱片台安裝目錄。"

  !insertmacro ADRelocationFunctions

  Function ADPrepareOptions
    StrCpy $adInstallMode $installMode
    ReadRegStr $adRegisteredDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCpy $adPreviousDir ""
    ${If} $adRegisteredDir != ""
    ${AndIf} ${FileExists} "$adRegisteredDir\${APP_EXECUTABLE_FILENAME}"
    ${AndIf} ${FileExists} "$adRegisteredDir\resources\app.asar"
      GetFullPathName $adPreviousDir "$adRegisteredDir"
    ${EndIf}
    ${If} $adPreviousDir == ""
      Call ADFindMovedInstallation
    ${EndIf}

    !insertmacro GetDParameter $0
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${ElseIf} $adPreviousDir != ""
      StrCpy $INSTDIR $adPreviousDir
    ${Else}
      System::Call 'kernel32::GetDriveTypeW(w "D:\") i.r0'
      ${If} $0 == 3
      ${AndIf} ${FileExists} "D:\*.*"
        StrCpy $INSTDIR "D:\${PRODUCT_FILENAME}"
      ${ElseIf} $adRegisteredDir != ""
        # Replace a stale entry with the normal Windows default if D: is unavailable.
        ${If} $installMode == "all"
          StrCpy $INSTDIR "$PROGRAMFILES64\${APP_FILENAME}"
        ${Else}
          StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    StrCpy $adSelectedDir $INSTDIR

    StrCpy $adDesktopChecked ${BST_CHECKED}
    !insertmacro setLinkVars
    ${If} ${isNoDesktopShortcut}
      StrCpy $adDesktopChecked ${BST_UNCHECKED}
    ${ElseIf} $adRegisteredDir != ""
    ${AndIfNot} ${FileExists} "$oldDesktopLink"
      StrCpy $adDesktopChecked ${BST_UNCHECKED}
    ${EndIf}
  FunctionEnd

  Function ADPrepareDirectoryPage
    ${If} $adInstallMode != $installMode
      Call ADPrepareOptions
    ${EndIf}
  FunctionEnd

  Function ADLeaveDirectoryPage
    ${NSD_GetText} $mui.DirectoryPage.Directory $INSTDIR
    Call ADValidateDirectory
  FunctionEnd

  Function ADCheckDestination
    # The uninstaller owns this directory. Protect files already there by
    # allowing a nonempty folder only when it contains an installed copy.
    StrCpy $adDestinationSafe "0"
    ${GetRoot} "$INSTDIR" $0
    ${If} $0 == ""
      Return
    ${EndIf}
    StrCpy $1 $INSTDIR 2
    StrCpy $2 $INSTDIR 1 2
    ${If} $1 != "\\"
    ${AndIf} $2 != "\"
    ${AndIf} $2 != "/"
      Return
    ${EndIf}
    # The native NSIS GetFullPathName can return blank for a folder that
    # does not exist yet. Win32 normalizes the path without creating it.
    StrCpy $0 $INSTDIR
    System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
    ${If} $2 <= 0
    ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
      Return
    ${EndIf}
    StrCpy $INSTDIR $1
    ${GetRoot} "$INSTDIR" $0
    ${If} $0 == ""
    ${OrIf} $INSTDIR == $0
    ${OrIf} $INSTDIR == "$0\"
      Return
    ${EndIf}
    ${If} $INSTDIR == $adPreviousDir
      StrCpy $adDestinationSafe "1"
      Return
    ${EndIf}
    !insertmacro ADIsInstalledCopy $INSTDIR $1
    ${If} $1 == "1"
      StrCpy $adDestinationSafe "1"
      Return
    ${EndIf}
    ClearErrors
    FindFirst $0 $1 "$INSTDIR\*"
    ${IfNot} ${Errors}
      ${While} $1 != ""
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          FindClose $0
          Return
        ${EndIf}
        FindNext $0 $1
      ${EndWhile}
      FindClose $0
    ${EndIf}
    ClearErrors
    StrCpy $adDestinationSafe "1"
  FunctionEnd

  Function ADValidateDirectory
    Call ADCheckDestination
    ${If} $adDestinationSafe != "1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(ADUnsafeDir)"
      Abort
    ${EndIf}
  FunctionEnd

  Function ADShowOptions
    !insertmacro MUI_HEADER_TEXT "$(ADOptions)" "$(ADConfirm)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == "error"
      Quit
    ${EndIf}
    ${NSD_CreateLabel} 0u 0u 100% 28u "$(ADDestination)$\r$\n$INSTDIR"
    Pop $0
    ${NSD_CreateCheckbox} 0u 37u 100% 13u "$(ADDesktop)"
    Pop $adDesktopCheckbox
    ${NSD_SetState} $adDesktopCheckbox $adDesktopChecked
    ${NSD_OnClick} $adDesktopCheckbox ADSaveDesktopChoice
    nsDialogs::Show
  FunctionEnd

  Function ADSaveDesktopChoice
    Pop $0
    ${NSD_GetState} $adDesktopCheckbox $adDesktopChecked
  FunctionEnd

  Function ADLeaveOptions
    ${NSD_GetState} $adDesktopCheckbox $adDesktopChecked
    Call ADValidateDirectory
    Call ADReconnectSelectedInstallation
  FunctionEnd
  !macroend

  !macro customInstall
    Call ADRememberInstallation
    ${If} $adDesktopChecked == ${BST_CHECKED}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "AlbumDeck"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${ElseIf} $adRegisteredDir != ""
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${EndIf}
  !macroend
!else
  !macro customHeader
    !insertmacro ADUninstallRelocationFunctions
  !macroend
!endif

!macro customUnInstall
  Call un.ADResolveRemovalDirectory
  ${IfNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}
!macroend
