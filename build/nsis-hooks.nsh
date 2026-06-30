; Howl NSIS hooks
;
; customInit:      Hide the installer window — the Electron app provides
;                  the branded install experience (install-screen.html).
; customInstall:   Manually launch the app after silent install. The default
;                  runAfterFinish path in installSection.nsh:91-103 only
;                  fires `${ifNot} ${Silent} ${orIf} ${isForceRun}`. Since
;                  SetSilent silent makes ${Silent} true and a fresh install
;                  isn't isForceRun, auto-launch is bypassed. We replicate
;                  doStartApp here so the user lands on install-screen.html.
; customUnInstall: Clean up user data + registry on a real (user-initiated)
;                  uninstall. Skipped during the update flow so app settings,
;                  localStorage, IndexedDB, etc. survive across versions.

!macro customInit
  SetSilent silent
!macroend

!macro customInstall
  ; Skip when isForceRun would handle the launch via the normal flow,
  ; otherwise we'd double-launch on update.
  ${If} ${Silent}
  ${AndIfNot} ${isForceRun}
    HideWindow
    ; Inline the StartApp body (common.nsh:123) using register vars so
    ; we don't trigger `Var /GLOBAL startAppArgs already declared` —
    ; doStartApp at installSection.nsh:96 also expands StartApp, and
    ; Var /GLOBAL is processed at compile time regardless of runtime
    ; ${If} branches.
    ${If} ${isUpdated}
      StrCpy $R0 "--updated"
    ${Else}
      StrCpy $R0 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $R1 "$launchLink" "open" "$R0"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Detect whether this uninstaller was invoked by another installer
  ; (auto-update or reinstall) versus the user clicking "Uninstall" in
  ; Windows. electron-builder's installSection.nsh runs the previous
  ; version's uninstaller during an update with `_?=$INSTDIR`, which is
  ; the standard NSIS convention for "uninstall in place; the parent
  ; installer will call me back." When _?= is present we PRESERVE user
  ; data — appearance, autostart, close-vs-minimize, login session,
  ; chat backgrounds, drafts — everything the user expects to survive
  ; an upgrade. Earlier versions wiped %APPDATA%\Howl in customUnInit,
  ; which fired on every update and silently logged the user out.
  ;
  ; A standalone uninstall (Add/Remove Programs, Settings → Apps) has no
  ; `_?=` argument; we drop the userData directory and the autostart
  ; Run-key the running app may have created via setLoginItemSettings.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "_?=" $R1
  ${If} ${Errors}
    ; Standalone uninstall — wipe user data + autostart entry.
    RMDir /r "$APPDATA\Howl"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Howl"
  ${EndIf}
!macroend
