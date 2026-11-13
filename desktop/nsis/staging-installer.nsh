; The staging build (packaging/staging-app.cjs) is named "Tandem" but keeps
; installing into its own folder, "Tandem Staging", as it always has: beside
; a regular Tandem, and where updates find it. A folder already chosen (an
; earlier install or update) is kept.
!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 +2
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Tandem Staging"
!macroend

; Tandem in Explorer's "Open with", for every type of file ("*"). It is only
; added to the list: the app a type opens with by default never changes.
; Its own ProgID, so a regular Tandem beside it (Tandem.File) is untouched.
; Removed again on uninstall.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\TandemStaging.File" "" "File opened in Tandem"
  WriteRegStr SHCTX "Software\Classes\TandemStaging.File\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\TandemStaging.File\shell\open" "FriendlyAppName" "Tandem"
  WriteRegStr SHCTX "Software\Classes\TandemStaging.File\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\*\OpenWithProgids" "TandemStaging.File" ""
  ; Tell Explorer the list changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\*\OpenWithProgids" "TandemStaging.File"
  DeleteRegKey SHCTX "Software\Classes\TandemStaging.File"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
