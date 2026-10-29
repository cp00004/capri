; CAPRI installer customisation
; The app installs per-user (no admin), so every registry write stays in HKCU.

!macro customInit
  ; Nothing extra needed.
!macroend

!macro customInstall
  WriteRegStr HKCU "SOFTWARE\Capricorn\Capri" "Installed" "1"
  WriteRegStr HKCU "SOFTWARE\Capricorn\Capri" "InstallDir" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "SOFTWARE\Capricorn\Capri"
!macroend
