Add-Type @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class P {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
Add-Type -AssemblyName System.Drawing

$proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "CAPRI // Project Capricorn" } | Select-Object -First 1
if (-not $proc) { "no window"; exit }
$h = $proc.MainWindowHandle
[void][P]::ShowWindow($h, 9)
[void][P]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 900

$r = New-Object P+RECT
[void][P]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][P]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$bmp.Save("C:\Users\TestUser\Downloads\CAPRI AI\capri-desktop\shot-win.png", [System.Drawing.Imaging.ImageFormat]::Png)
"size=$w x $ht"
