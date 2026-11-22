# Recognize a complete installed copy before letting NSIS own its directory.
!macro ADIsInstalledCopy directory result
  StrCpy ${result} "0"
  ${If} ${directory} != ""
  ${AndIf} ${FileExists} "${directory}\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "${directory}\${UNINSTALL_FILENAME}"
  ${AndIf} ${FileExists} "${directory}\resources\app.asar"
    ${GetRoot} "${directory}" ${result}
    ${If} ${result} == ""
    ${OrIf} ${directory} == ${result}
    ${OrIf} ${directory} == "${result}\"
      StrCpy ${result} "0"
    ${Else}
      StrCpy ${result} "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro ADRelocationFunctions
  # BY_HANDLE_FILE_INFORMATION: handle in $0, success in $1; volume serial,
  # file ID (low/high), and creation time (low/high) in $2 through $6.
  Function ADReadIdentity
    System::Alloc 52
    Pop $7
    System::Call 'kernel32::GetFileInformationByHandle(p r0, p r7) i.r1'
    ${If} $1 != 0
      System::Call '*$7(i, i .r5, i .r6, i, i, i, i, i .r2, i, i, i, i .r4, i .r3)'
    ${EndIf}
    System::Free $7
  FunctionEnd

  Function ADRememberInstallation
    DeleteRegValue SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackVolume
    ${GetRoot} "$INSTDIR" $R0
    StrLen $R1 $R0
    ${If} $R1 != 2
      ClearErrors
      Return
    ${EndIf}
    # FILE_READ_ATTRIBUTES, share all, OPEN_EXISTING.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${UNINSTALL_FILENAME}", i 0x80, i 7, p 0, i 3, i 0, p 0) p.r0'
    ${If} $0 == -1
      ClearErrors
      Return
    ${EndIf}
    System::Call 'kernel32::GetVolumeInformationByHandleW(p r0, p 0, i 0, p 0, p 0, p 0, w .r1, i ${NSIS_MAX_STRLEN}) i.r7'
    ${If} $7 != 0
    ${AndIf} $1 == "NTFS"
      Call ADReadIdentity
      ${If} $1 != 0
        WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdentity "$2:$3:$4:$5:$6"
        WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdLow $3
        WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdHigh $4
        WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackVolume "$R0\"
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
    ClearErrors
  FunctionEnd

  Function ADFindMovedInstallation
    ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackVolume
    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdentity
    ${If} $R0 == ""
    ${OrIf} $R2 == ""
      ClearErrors
      Return
    ${EndIf}
    # A handle to the volume's root is sufficient, with no elevation needed.
    System::Call 'kernel32::CreateFileW(w "$R0", i 0x80, i 7, p 0, i 3, i 0x02000000, p 0) p.r8'
    ${If} $8 == -1
      Return
    ${EndIf}
    ReadRegDWORD $3 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdLow
    ReadRegDWORD $4 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" TrackIdHigh
    # FILE_ID_DESCRIPTOR: size, FileIdType, 64-bit ID and reserved union space.
    System::Call '*(i 24, i 0, i r3, i r4, i 0, i 0) p.r9'
    System::Call 'kernel32::OpenFileById(p r8, p r9, i 0x80, i 7, p 0, i 0) p.r0'
    System::Free $9
    System::Call 'kernel32::CloseHandle(p r8)'
    ${If} $0 != -1
      Call ADReadIdentity
      ${If} $1 != 0
      ${AndIf} "$2:$3:$4:$5:$6" == $R2
        System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w .r7, i ${NSIS_MAX_STRLEN}, i 0) i.r8'
        StrCpy $1 $7 4
        ${If} $8 > 4
        ${AndIf} $8 < ${NSIS_MAX_STRLEN}
        ${AndIf} $1 == "\\?\"
          StrCpy $7 $7 "" 4
          ${GetParent} "$7" $R1
          !insertmacro ADIsInstalledCopy $R1 $9
          ${If} $9 == "1"
          ${AndIf} $7 == "$R1\${UNINSTALL_FILENAME}"
            StrCpy $adPreviousDir $R1
          ${EndIf}
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
    ClearErrors
  FunctionEnd

  Function ADReconnectSelectedInstallation
    # Record a moved copy only after an install has been confirmed. If a
    # separate existing install is still registered, leave it authoritative.
    !insertmacro ADIsInstalledCopy $adRegisteredDir $1
    ${If} $1 == "1"
      Return
    ${EndIf}
    !insertmacro ADIsInstalledCopy $INSTDIR $1
    ${If} $1 != "1"
      Return
    ${EndIf}
    StrCpy $0 "/currentuser"
    ${If} $installMode == "all"
      StrCpy $0 "/allusers"
    ${EndIf}
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" $0'
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" $0 /S'
  FunctionEnd
!macroend

!macro ADUninstallRelocationFunctions
  LangString ADUninstallPath ${LANG_ENGLISH} "Cannot verify this AlbumDeck installation. Open the installer and select the folder containing AlbumDeck.exe."
  LangString ADUninstallPath ${LANG_SIMPCHINESE} "无法确认此唱片台安装目录。请打开安装向导，选择包含 AlbumDeck.exe 的文件夹后重新安装。"
  LangString ADUninstallPath ${LANG_TRADCHINESE} "無法確認此唱片台安裝目錄。請開啟安裝精靈，選擇包含 AlbumDeck.exe 的資料夾後重新安裝。"

  Function un.ADResolveRemovalDirectory
    # NSIS's temporary uninstaller is started with _?= pointing to the
    # original folder. Read the raw command line: NSIS strips it from $CMDLINE.
    ${StdUtils.GetAllParameters} $0 "0"
    StrCpy $0 " $0"
    StrLen $1 $0
    IntOp $1 $1 - 4
    StrCpy $R1 ""
    ${While} $1 >= 0
      StrCpy $2 $0 4 $1
      ${If} $2 == " _?="
        IntOp $1 $1 + 4
        StrCpy $R1 $0 "" $1
        ${Break}
      ${EndIf}
      IntOp $1 $1 - 1
    ${EndWhile}
    ${If} $R1 == ""
      StrCpy $R1 $EXEDIR
    ${EndIf}
    GetFullPathName $R1 "$R1"
    # The self-copied uninstaller's _?= argument may end in a backslash.
    StrCpy $0 $R1 1 -1
    ${If} $0 == "\"
      StrCpy $R1 $R1 -1
    ${EndIf}
    !insertmacro ADIsInstalledCopy $R1 $1
    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    !insertmacro ADIsInstalledCopy $R2 $2
    ${If} $1 == "1"
      ${If} $2 == "1"
        GetFullPathName $R2 "$R2"
        StrCpy $0 $R2 1 -1
        ${If} $0 == "\"
          StrCpy $R2 $R2 -1
        ${EndIf}
        ${If} $R1 != $R2
          StrCpy $1 "0"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $1 != "1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(ADUninstallPath)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $INSTDIR $R1
  FunctionEnd
!macroend
