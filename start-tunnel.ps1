# Start Capri server + Cloudflare tunnel together
$env:CAPRI_AUTOPUBLISH = "1"
$server = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory (Get-Location) -RedirectStandardOutput "$env:TEMP\capri-out.log" -RedirectStandardError "$env:TEMP\capri-err.log" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$tunnel = Start-Process -FilePath "powershell" -ArgumentList "-Command", "cloudflared tunnel --url http://localhost:4173 2>&1 | Tee-Object -FilePath $env:TEMP\cf-tunnel.log" -WindowStyle Hidden -PassThru
Write-Host "Server PID: $($server.Id)"
Write-Host "Tunnel PID: $($tunnel.Id)"
Write-Host "Waiting for tunnel URL..."
Start-Sleep -Seconds 20
$url = Get-Content "$env:TEMP\cf-tunnel.log" | Select-String "trycloudflare.com" | Select-Object -Last 1
Write-Host "Tunnel URL: $url"
Write-Host "Press Ctrl+C to stop both"
while ($true) { Start-Sleep -Seconds 10 }