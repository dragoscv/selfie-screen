; TikSee NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; TikSee Camera = tiksee_vcam.dll (loaded by the Windows Camera Frame Server)
; + tiksee-vcam-setup.exe, both shipped next to TikSee.exe via
; bundle.resources. The installer runs elevated (installMode perMachine), so
; the helper can write HKLM and create the system-wide virtual camera.
; Failures are logged and never abort the install: the app's
; "Repair camera" button re-runs the same helper.

!macro TIKSEE_STOP_FRAMESERVER
  ; The Frame Server keeps tiksee_vcam.dll loaded while any app uses a
  ; camera; stop it so the file can be replaced or deleted. Both services
  ; are demand-start and come back on the next camera open.
  DetailPrint "Stopping Windows Camera Frame Server"
  nsExec::Exec 'net stop FrameServerMonitor /y'
  Pop $0
  nsExec::Exec 'net stop FrameServer /y'
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TIKSEE_STOP_FRAMESERVER
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering TikSee Camera"
  nsExec::ExecToLog '"$INSTDIR\tiksee-vcam-setup.exe" install'
  Pop $0
  ${If} $0 != 0
    DetailPrint "TikSee Camera registration failed ($0); use Repair camera in TikSee"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing TikSee Camera"
  nsExec::ExecToLog '"$INSTDIR\tiksee-vcam-setup.exe" uninstall'
  Pop $0
  !insertmacro TIKSEE_STOP_FRAMESERVER
!macroend
