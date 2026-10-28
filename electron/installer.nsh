; CAPRI installer customisation — requests mic + full PC permissions
; This runs inside the NSIS installer context

!macro customInit
  ; Nothing extra needed — UAC handled by requestedExecutionLevel=requireAdministrator
!macroend

!macro customInstall
  ; Write a registry flag so the app knows it was installed system-wide
  WriteRegStr HKLM "SOFTWARE\Capricorn\Capri" "Installed" "1"
  WriteRegStr HKLM "SOFTWARE\Capricorn\Capri" "InstallDir" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey HKLM "SOFTWARE\Capricorn\Capri"
!macroend
