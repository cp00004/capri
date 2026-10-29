; CAPRI installer customisation
; The app installs per machine, so the registry markers live in HKLM.

!macro customInit
  ; Nothing extra needed.
!macroend

!macro customInstall
  WriteRegStr HKLM "SOFTWARE\Capricorn\Capri" "Installed" "1"
  WriteRegStr HKLM "SOFTWARE\Capricorn\Capri" "InstallDir" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey HKLM "SOFTWARE\Capricorn\Capri"
!macroend
