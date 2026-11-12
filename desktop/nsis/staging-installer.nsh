; The staging build (packaging/staging-app.cjs) is named "Tandem" but keeps
; installing into its own folder, "Tandem Staging", as it always has: beside
; a regular Tandem, and where updates find it. A folder already chosen (an
; earlier install or update) is kept.
!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 +2
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Tandem Staging"
!macroend
