# CI (Windows): installs the setup, then asks Windows itself which apps
# Explorer's "Open with" offers (SHAssocEnumHandlers, as Explorer does) for
# several types, including a PDF, an image and a type nobody registers.
# Tandem Staging must be offered for all of them, open the installed app,
# and leave every type's default app alone; uninstalling removes it.
#
#   powershell -File packaging/open-with-check.ps1 <setup.exe>
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OpenWith {
  [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAssocHandler {
    [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
  }
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumAssocHandlers {
    [PreserveSig] int Next(int celt, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler rgelt, out int pceltFetched);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHAssocEnumHandlers(string pszExtra, int afFilter, out IEnumAssocHandlers ppEnumHandler);
  public static List<string> Names(string ext) {
    var list = new List<string>();
    IEnumAssocHandlers e;
    if (SHAssocEnumHandlers(ext, 0, out e) != 0 || e == null) return list;
    IAssocHandler h; int n;
    while (e.Next(1, out h, out n) == 0 && n == 1) { string ui; h.GetUIName(out ui); list.Add(ui); }
    return list;
  }
}
'@
$classes = 'HKCU:\Software\Classes'
function DefaultOf($key) { $k = Get-Item -LiteralPath "$classes\$key" -ErrorAction SilentlyContinue; if ($k) { $k.GetValue('') } else { $null } }
$types = '.py', '.ipynb', '.sql', '.csv', '.txt', '.yaml', '.pdf', '.png', '.zzq9'
$defaults = @{}
foreach ($t in $types) { $defaults[$t] = DefaultOf $t }

Start-Process -FilePath $Setup -ArgumentList '/S' -Wait
$command = DefaultOf 'TandemStaging.File\shell\open\command'
Write-Output "open command: $command"
if ($command -notmatch '^"(.+\\Tandem\.exe)" "%1"$') { throw 'TandemStaging.File has no open command' }
$exe = $Matches[1]
if (-not (Test-Path -LiteralPath $exe)) { throw "installed app not found: $exe" }
foreach ($t in $types) {
  $names = [OpenWith]::Names($t)
  if ($names -notcontains 'Tandem') { throw "Tandem is not in Open with for $t (offered: $($names -join ', '))" }
  if ((DefaultOf $t) -ne $defaults[$t]) { throw "the default app for $t changed" }
}
Write-Output "ok   installed: Explorer offers Tandem in Open with for $($types -join ' ') (any type); no default app changed"

$uninstaller = Join-Path (Split-Path $exe) 'Uninstall Tandem.exe'
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
for ($i = 0; $i -lt 60 -and (DefaultOf 'TandemStaging.File\shell\open\command'); $i++) { Start-Sleep -Seconds 1 }
if (DefaultOf 'TandemStaging.File\shell\open\command') { throw 'Open with entries left after uninstall' }
foreach ($t in '.zzq9', '.py') {
  if ([OpenWith]::Names($t) -contains 'Tandem') { throw "Tandem still in Open with for $t after uninstall" }
}
Write-Output 'ok   uninstalled: Tandem is no longer in Open with'
