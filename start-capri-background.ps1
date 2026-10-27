$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$scriptPath = Join-Path $root "server.js"
$pidFile = Join-Path $env:TEMP "capri-server.pid"
$server = $null

if (Test-Path $pidFile) {
  $savedPid = 0
  if ([int]::TryParse((Get-Content $pidFile -Raw), [ref]$savedPid)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine.Contains($scriptPath)) {
      $server = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    }
  }
}

if (-not $server) {
  $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    $server = Start-Process -FilePath "node.exe" -ArgumentList @("`"$scriptPath`"") -WorkingDirectory $root -RedirectStandardOutput (Join-Path $env:TEMP "capri-server-out.log") -RedirectStandardError (Join-Path $env:TEMP "capri-server-err.log") -PassThru -WindowStyle Hidden
    Set-Content -Path $pidFile -Value $server.Id -NoNewline
  }
}

Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "open-capri.ps1")) -WindowStyle Hidden