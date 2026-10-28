# Auto-start Capri server + Cloudflare-style tunnel on PC boot
$env:CAPRI_AUTOPUBLISH = "1"
$server = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\Users\TestUser\Downloads\capri ai\capri-desktop" -RedirectStandardOutput "C:\Users\TestUser\AppData\Local\Temp\capri-out.log" -RedirectStandardError "C:\Users\TestUser\AppData\Local\Temp\capri-err.log" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
$tunnel = Start-Process -FilePath "powershell" -ArgumentList "-Command", "lt --port 4173 --subdomain capriai 2>&1 | Tee-Object -FilePath $env:TEMP\lt-tunnel.log" -WindowStyle Hidden -PassThru
Write-Host "Server PID: $($server.Id)"
Write-Host "Tunnel PID: $($tunnel.Id)"
