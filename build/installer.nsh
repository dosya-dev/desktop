; Windows URL-protocol registration for dosya://
;
; electron-builder's `protocols:` config block is only consumed by the macOS
; (Info.plist), Linux (.desktop) and AppX packagers. The NSIS target ignores it,
; so nothing ever wrote the registry keys Windows needs and the OAuth callback
; redirect - dosya://auth/callback?token=... - died in the browser with no
; handler to launch. macOS worked off the same config line, which is why the
; flow looked healthy everywhere except Windows.
;
; SHELL_CONTEXT follows the install mode electron-builder picked: HKCU for the
; default per-user install (no admin needed), HKLM for a per-machine one. It is
; the same root the surrounding electron-builder templates write to.
;
; The "%1" placeholder is the whole point of these keys - it is what puts the
; callback URL into the app's argv, where findDeepLinkArg picks it up.

!macro customInstall
  DetailPrint "Registering dosya:// protocol handler"
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya" "" "URL:dosya Protocol"
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya\shell" "" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya\shell\open" "" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\dosya\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Only clear the association if it still points at this install, so a
  ; side-by-side install that owns the scheme keeps it.
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\dosya\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey SHELL_CONTEXT "Software\Classes\dosya"
  ${EndIf}
  Pop $0
!macroend
