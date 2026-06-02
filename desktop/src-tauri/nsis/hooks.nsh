; Refresh shortcut icons after Tauri creates them. Windows can keep showing
; the previous app icon from its .lnk/exe icon cache after an in-place update.
!macro REASONIX_REFRESH_SHORTCUT SHORTCUT_PATH
  IfFileExists "${SHORTCUT_PATH}" 0 +3
    Delete "${SHORTCUT_PATH}"
    CreateShortCut "${SHORTCUT_PATH}" "$INSTDIR\reasonix-desktop.exe" "" "$0" 0 SW_SHOWNORMAL "" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  StrCpy $0 "$INSTDIR\icons\icon.ico"
  IfFileExists "$0" +2 0
    StrCpy $0 "$INSTDIR\reasonix-desktop.exe"

  !insertmacro REASONIX_REFRESH_SHORTCUT "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro REASONIX_REFRESH_SHORTCUT "$SMPROGRAMS\${PRODUCTNAME}.lnk"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  Pop $0
!macroend
