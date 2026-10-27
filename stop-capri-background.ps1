$ErrorActionPreference = "Stop"
$pidFile = Join-Path $env:TEMP "capri-server.pid"
if (-not (Test-Path $pidFile)) {
  Write-Output "No Capri background server was started by start-capri.cmd."
  exit 0
}

$serverPid = 0
if ([int]::TryParse((Get-Content $pidFile -Raw), [ref]$serverPid)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
  $scriptPath = Join-Path $PSScriptRoot "server.js"
  if ($process -and $process.CommandLine.Contains($scriptPath)) {
    Stop-Process -Id $serverPid -Force
    Write-Output "Stopped Capri server."
  }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue