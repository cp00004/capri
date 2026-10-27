# Waits for the local Capri server, then opens her in a chromeless app window.
# Used by start-capri.cmd. Falls back to the default browser if Chrome/Edge is missing.

$ErrorActionPreference = 'SilentlyContinue'

$port = 4173
$url  = "http://localhost:$port"

# 1. wait for the server to answer (max ~20s)
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try {
    $client = New-Object Net.Sockets.TcpClient('127.0.0.1', $port)
    $client.Close()
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

# 2. find a chromium browser
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ }

$exe = $candidates | Select-Object -First 1

# 3. app mode = no tabs, no address bar, its own profile so the mic permission sticks
if ($exe) {
  Start-Process $exe -ArgumentList @(
    "--app=$url",
    "--window-size=1366,900",
    "--user-data-dir=$env:LOCALAPPDATA\CapriLink",
    "--no-first-run",
    "--no-default-browser-check"
  )
} else {
  Start-Process $url
}
