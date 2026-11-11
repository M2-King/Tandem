; Tandem in Explorer's "Open with" for Python, notebook, SQL and text files.
;
; Tandem is only added to each type's Open with list: the app a type opens
; with by default is never changed. Removed again on uninstall.

!macro tandemForEachType MACRO
  !insertmacro ${MACRO} "py"
  !insertmacro ${MACRO} "pyw"
  !insertmacro ${MACRO} "ipynb"
  !insertmacro ${MACRO} "sql"
  !insertmacro ${MACRO} "csv"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "txt"
!macroend

!macro tandemAddType EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Tandem.File" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro tandemRemoveType EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Tandem.File"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Tandem.File" "" "File opened in Tandem"
  WriteRegStr SHCTX "Software\Classes\Tandem.File\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Tandem.File\shell\open" "FriendlyAppName" "Tandem"
  WriteRegStr SHCTX "Software\Classes\Tandem.File\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Tandem"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro tandemForEachType tandemAddType
  ; Tell Explorer the list changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro tandemForEachType tandemRemoveType
  DeleteRegKey SHCTX "Software\Classes\Tandem.File"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
