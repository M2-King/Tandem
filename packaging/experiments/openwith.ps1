# Temporary: which registry entries put an app in Explorer's "Open with" for every file type.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Assoc {
  [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAssocHandler {
    [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string ppszPath, out int pIndex);
    [PreserveSig] int IsRecommended();
  }
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumAssocHandlers {
    [PreserveSig] int Next(int celt, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler rgelt, out int pceltFetched);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHAssocEnumHandlers(string pszExtra, int afFilter, out IEnumAssocHandlers ppEnumHandler);
  public static List<string> Handlers(string ext, int filter) {
    var list = new List<string>();
    IEnumAssocHandlers e;
    if (SHAssocEnumHandlers(ext, filter, out e) != 0 || e == null) return list;
    IAssocHandler h; int n;
    while (e.Next(1, out h, out n) == 0 && n == 1) {
      string name, ui; h.GetName(out name); h.GetUIName(out ui);
      list.Add(ui + " <" + name + ">" + (h.IsRecommended() == 0 ? " [recommended]" : ""));
    }
    return list;
  }
}
'@
$dir = 'C:\tw'
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($v in 'One','Two','Three') { Copy-Item "$env:WINDIR\System32\notepad.exe" "$dir\Tandem$v.exe" }
$C = 'HKCU:\Software\Classes'
function Key($p) { New-Item -Path $p -Force | Out-Null; $p }
# One: a ProgID listed under * \OpenWithProgids
Key "$C\TandemOne.File\shell\open\command" | Out-Null
Set-ItemProperty "$C\TandemOne.File\shell\open\command" '(default)' "`"$dir\TandemOne.exe`" `"%1`""
Set-ItemProperty (Key "$C\TandemOne.File\shell\open") 'FriendlyAppName' 'Tandem One'
New-ItemProperty -Path (Key "$C\*\OpenWithProgids") -Name 'TandemOne.File' -Value ([byte[]]@()) -PropertyType None -Force | Out-Null
# Two: Applications\TandemTwo.exe listed under * \OpenWithList
Key "$C\Applications\TandemTwo.exe\shell\open\command" | Out-Null
Set-ItemProperty "$C\Applications\TandemTwo.exe\shell\open\command" '(default)' "`"$dir\TandemTwo.exe`" `"%1`""
Set-ItemProperty "$C\Applications\TandemTwo.exe" 'FriendlyAppName' 'Tandem Two'
Key "$C\*\OpenWithList\TandemTwo.exe" | Out-Null
# Three: per-extension OpenWithProgids (as Tandem 0.9.0 does), for .ipynb only
Key "$C\TandemThree.File\shell\open\command" | Out-Null
Set-ItemProperty "$C\TandemThree.File\shell\open\command" '(default)' "`"$dir\TandemThree.exe`" `"%1`""
New-ItemProperty -Path (Key "$C\.ipynb\OpenWithProgids") -Name 'TandemThree.File' -Value ([byte[]]@()) -PropertyType None -Force | Out-Null

foreach ($ext in '.ipynb', '.py', '.txt', '.pdf', '.png', '.zzq9', '.docx') {
  foreach ($f in @(@{n='all';v=0}, @{n='recommended';v=2})) {
    $h = [Assoc]::Handlers($ext, $f.v) | Where-Object { $_ -match 'Tandem' }
    "$ext ($($f.n)): " + ($(if ($h) { $h -join ' | ' } else { '-' }))
  }
}
