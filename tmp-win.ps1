Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class E {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
'@

$targets = (Get-Process Capri -ErrorAction SilentlyContinue).Id
$script:rows = @()
$cb = [E+EnumProc]{
  param($h, $p)
  $procId = 0
  [void][E]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($targets -contains [int]$procId) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][E]::GetWindowText($h, $sb, 256)
    $cloaked = 0
    [void][E]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
    if ($sb.Length -gt 0) {
      $script:rows += ("h={0} pid={1} vis={2} cloaked={3} title={4}" -f $h, $procId, [E]::IsWindowVisible($h), $cloaked, $sb.ToString())
    }
  }
  return $true
}
[void][E]::EnumWindows($cb, [IntPtr]::Zero)
$script:rows
"targets: " + ($targets -join ",")
