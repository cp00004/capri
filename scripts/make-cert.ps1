# ============================================================
# CAPRI // local certificate for the phone link
# Phones only hand over the microphone to a secure (https) page.
# This makes a self-signed certificate for this PC's LAN addresses.
# Run it again if your LAN IP changes.
# ============================================================

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---- find openssl (Git for Windows ships one)
$openssl = $null
foreach ($c in @("openssl", "C:\Program Files\Git\usr\bin\openssl.exe", "C:\Program Files\Git\mingw64\bin\openssl.exe")) {
  try {
    $null = & $c version 2>$null
    if ($LASTEXITCODE -eq 0) { $openssl = $c; break }
  } catch { }
}
if (-not $openssl) {
  Write-Host "openssl not found. Install Git for Windows (it includes openssl), then run this again." -ForegroundColor Red
  exit 1
}

# ---- collect addresses the phone might use
$ips = @()
foreach ($list in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  if ($list.OperationalStatus -ne "Up") { continue }
  foreach ($addr in $list.GetIPProperties().UnicastAddresses) {
    if ($addr.Address.AddressFamily -eq "InterNetwork" -and -not $addr.Address.ToString().StartsWith("169.254.")) {
      $ips += $addr.Address.ToString()
    }
  }
}
$ips = $ips | Sort-Object -Unique
$lanIps = @($ips | Where-Object { $_ -notmatch "^(127\.|169\.254\.)" })
$primary = if ($lanIps.Count) { $lanIps[0] } else { "127.0.0.1" }
$san = @("DNS:localhost", "DNS:$env:COMPUTERNAME", "IP:127.0.0.1")
foreach ($ip in $ips) { $san += "IP:$ip" }
$sanText = $san -join ","

Write-Host ""
Write-Host "  CAPRI // issuing a local certificate" -ForegroundColor Magenta
Write-Host "  addresses: $($ips -join ', ')"
Write-Host ""

# 397 days: iOS rejects longer-lived server certificates.
$opensslArgs = @(
  "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "397",
  "-keyout", (Join-Path $root "key.pem"),
  "-out", (Join-Path $root "cert.pem"),
  "-subj", "/CN=Capri Local/O=Capri",
  "-addext", "subjectAltName=$sanText",
  "-addext", "basicConstraints=critical,CA:TRUE",
  "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  "-addext", "extendedKeyUsage=serverAuth"
)
$ErrorActionPreference = "Continue"
& $openssl @opensslArgs 2>$null
$code = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($code -ne 0 -or -not (Test-Path "cert.pem") -or -not (Test-Path "key.pem")) {
  Write-Host "  certificate generation failed (openssl exit $code)." -ForegroundColor Red
  exit 1
}

Write-Host "  wrote cert.pem and key.pem" -ForegroundColor Green
Write-Host ""
Write-Host "  next:" -ForegroundColor Cyan
Write-Host "   1. restart the server (node server.js) - it will also listen on https"
Write-Host "   2. on the phone, open http://$($primary):4173/cert and install the file"
Write-Host "      Android: Settings > Security > Install a certificate > CA certificate"
Write-Host "      iPhone:  Settings > Profile Downloaded > Install, then"
Write-Host "               Settings > General > About > Certificate Trust Settings > trust Capri Local"
Write-Host "   3. open https://$($primary):4174 and pair with the code on the PC"
Write-Host ""


