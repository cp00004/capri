Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class T {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  static public List<string> Dump(IntPtr parent) {
    var outl = new List<string>();
    EnumChildWindows(parent, (h, l) => {
      var sb = new StringBuilder(2048);
      GetWindowText(h, sb, 2048);
      var cn = new StringBuilder(256);
      GetClassName(h, cn, 256);
      if (sb.Length > 0) outl.Add(cn + ": " + sb);
      return true;
    }, IntPtr.Zero);
    return outl;
  }
}
'@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $p.MainWindowTitle
  [T]::Dump($p.MainWindowHandle)
} else { "no window" }
