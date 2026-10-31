$sh = New-Object -ComObject WScript.Shell
foreach ($p in @(
  "C:\Users\TestUser\Desktop\Capri.lnk",
  "C:\Users\TestUser\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Capri.lnk"
)) {
  if (Test-Path $p) {
    $l = $sh.CreateShortcut($p)
    Write-Output "$p -> $($l.TargetPath)"
  } else {
    Write-Output "$p -> MISSING"
  }
}
$dir = "C:\Users\TestUser\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Capri"
if (Test-Path $dir) { Get-ChildItem $dir | ForEach-Object { $l = $sh.CreateShortcut($_.FullName); Write-Output "$($_.Name) -> $($l.TargetPath)" } }
