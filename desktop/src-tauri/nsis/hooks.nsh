; Refresh shortcut icons after Tauri creates them. Windows can keep showing
; the previous app icon from its .lnk/exe icon cache after an in-place update.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
    CreateShortCut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\reasonix-desktop.exe" "" "$INSTDIR\reasonix-desktop.exe" 0

  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
    CreateShortCut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\reasonix-desktop.exe" "" "$INSTDIR\reasonix-desktop.exe" 0

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
