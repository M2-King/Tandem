# "Updating Tandem": a small window that shows the update's progress after
# Tandem has closed and its installer runs silently (desktop/updatingWindow.js
# starts it just before quitting). Windows PowerShell 5.1 and WinForms, which
# every Windows 10 and 11 has.
#
# Progress: the installer removes the old version, then unpacks the new one
# into the same folder. The folder's size against its size before the update
# (Baseline) gives the progress; the window closes once the new Tandem runs.
#
#   -InstallDir     the app's folder          -ExeName  the app's .exe name
#   -AppName        the name to show          -Version  the version to show
#   -Baseline       the folder's size in bytes before the update (0: unknown)
#   -ReadyFile      written once the window is on screen (Tandem quits after that)
#   -LogFile        what happened, for when something goes wrong (temp folder)
#   -NoRelaunch     Tandem was closed with an update waiting: the installer
#                   doesn't open it again, so the window ends once installed
#   -TestSeconds    CI: simulate an update for this long, then exit
#   -ScreenshotPath CI: save the window as a .png before exiting

param(
  [string]$InstallDir = '',
  [string]$ExeName = 'Tandem.exe',
  [string]$AppName = 'Tandem',
  [string]$Version = '',
  [double]$Baseline = 0,
  [string]$ReadyFile = '',
  [string]$LogFile = '',
  [int]$TimeoutSeconds = 300,
  [int]$TestSeconds = 0,
  [string]$ScreenshotPath = '',
  [switch]$NoRelaunch
)

$ErrorActionPreference = 'Stop'
function Write-Log($text) {
  if (-not $LogFile) { return }
  try { Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $text) -Encoding ASCII } catch {}
}
Write-Log "start: app=$AppName version=$Version dir=$InstallDir baseline=$Baseline test=$TestSeconds"
# Tandem starts this hidden (no console window). Windows applies "hidden" to
# the first window a program shows, so the window shows itself again, on top.
Add-Type -Namespace TandemUpdating -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
$ell = [string][char]0x2026  # an ellipsis (kept out of the file: PowerShell 5.1 reads it as ANSI)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Tandem's colours.
$bg = [System.Drawing.Color]::FromArgb(255, 27, 29, 36)
$fg = [System.Drawing.Color]::FromArgb(255, 230, 233, 239)
$muted = [System.Drawing.Color]::FromArgb(255, 150, 156, 170)
$trackColor = [System.Drawing.Color]::FromArgb(255, 48, 52, 64)
$accent = [System.Drawing.Color]::FromArgb(255, 122, 150, 230)
$sheenColor = [System.Drawing.Color]::FromArgb(255, 170, 190, 245)
$done = [System.Drawing.Color]::FromArgb(255, 92, 196, 140)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Updating $AppName"
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(440, 172)
$form.BackColor = $bg
$form.TopMost = $true
$form.ShowInTaskbar = $true
# Rounded corners.
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 16
$w = $form.ClientSize.Width
$h = $form.ClientSize.Height
$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
$path.AddArc($w - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$path.AddArc($w - $r * 2, $h - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc(0, $h - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)
# The app's own icon (read now: the installer replaces the file).
$exePath = if ($InstallDir) { Join-Path $InstallDir $ExeName } else { '' }
try { if ($exePath -and (Test-Path $exePath)) { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath) } } catch {}

function New-Label($text, $x, $y, $width, $size, $color, $bold) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($width, [int]($size * 2.4))
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $style)
  $l.ForeColor = $color
  $l.BackColor = $bg
  $form.Controls.Add($l)
  return $l
}

$title = New-Label "Updating $AppName" 28 22 384 13 $fg $true
$versionText = if ($Version) { "Installing $Version. " } else { '' }
$sub = New-Label "$versionText$AppName opens again by itself when it's done." 28 54 384 9.5 $muted $false
$phase = New-Label "Closing $AppName$ell" 28 104 300 9 $muted $false
$pct = New-Label '' 330 104 82 9 $muted $false
$pct.TextAlign = 'TopRight'

# The bar: a track, a fill that eases to the progress, and a moving sheen.
$track = New-Object System.Windows.Forms.Panel
$track.Location = New-Object System.Drawing.Point(28, 132)
$track.Size = New-Object System.Drawing.Size(384, 6)
$track.BackColor = $trackColor
$fill = New-Object System.Windows.Forms.Panel
$fill.Location = New-Object System.Drawing.Point(0, 0)
$fill.Size = New-Object System.Drawing.Size(0, 6)
$fill.BackColor = $accent
$sheen = New-Object System.Windows.Forms.Panel
$sheen.Size = New-Object System.Drawing.Size(44, 6)
$sheen.BackColor = $sheenColor
$fill.Controls.Add($sheen)
$track.Controls.Add($fill)
$form.Controls.Add($track)

$script:target = 3.0     # where the bar is heading (0-100)
$script:shown = 0.0      # where it is
$script:sheenX = -44
$script:removedSeen = $false
$script:lastSize = -1
$script:stableSince = $null   # the folder stopped changing (installed)
$script:installedAt = $null
$script:finished = $false
$script:closeAt = $null
$script:size = $Baseline
$start = Get-Date

function Set-Phase($text, $percent) {
  $phase.Text = $text
  if ($percent -gt $script:target) { $script:target = [Math]::Min(100, $percent) }
}

# The folder's size, measured off the window's thread so the animation stays smooth.
$measure = $null
$measureHandle = $null
function Start-Measure {
  $script:measure = [PowerShell]::Create()
  [void]$script:measure.AddScript({
    param($dir)
    $sum = 0
    try {
      foreach ($f in [System.IO.Directory]::EnumerateFiles($dir, '*', 'AllDirectories')) {
        try { $sum += ([System.IO.FileInfo]$f).Length } catch {}
      }
    } catch {}
    $sum
  }).AddArgument($InstallDir)
  $script:measureHandle = $script:measure.BeginInvoke()
}

# The new version runs: a program in the app's folder started after this
# window (its .exe may have a new name, e.g. "Tandem Staging.exe" -> "Tandem.exe").
function Test-NewAppRunning {
  if (-not $InstallDir) { return $false }
  $dir = $InstallDir.TrimEnd('\')
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    try {
      $file = $p.Path
      if ($file -and $file.EndsWith('.exe', 'OrdinalIgnoreCase') -and
          [System.IO.Path]::GetDirectoryName($file).Equals($dir, 'OrdinalIgnoreCase') -and
          -not [System.IO.Path]::GetFileName($file).StartsWith('Uninstall', 'OrdinalIgnoreCase') -and
          $p.StartTime -gt $start) { return $true }
    } catch {}
  }
  return $false
}

# Every half second: where the update is.
$check = New-Object System.Windows.Forms.Timer
$check.Interval = 500
$script:failed = $false
function Finish-Window($text, $ms) {
  $script:finished = $true
  $script:target = 100
  $pct.Visible = $false
  $phase.Width = 384
  $phase.Text = $text
  $script:closeAt = (Get-Date).AddMilliseconds($ms)
  Write-Log "finished: $text"
}
# A problem never shows an error box during a real update: the window just
# closes (the update goes on). In the CI test it fails the step.
function Stop-OnError($err) {
  Write-Log "error: $err"
  if ($TestSeconds -gt 0) { [Console]::Error.WriteLine("updating.ps1: $err"); $script:failed = $true }
  $form.Close()
}

$check.Add_Tick({ try {
  $elapsed = ((Get-Date) - $start).TotalSeconds
  if ($script:finished) {
    if ((Get-Date) -ge $script:closeAt) { $form.Close() }
    return
  }
  if ($TestSeconds -gt 0) {
    # CI: a made-up update, through every phase.
    $t = $elapsed / $TestSeconds
    if ($t -lt 0.15) { Set-Phase "Closing $AppName$ell" 5 }
    elseif ($t -lt 0.3) { Set-Phase "Removing the old version$ell" 12 }
    elseif ($t -lt 0.85) { Set-Phase "Installing the new version$ell" (12 + 80 * ($t - 0.3) / 0.55) }
    else { Set-Phase "Opening $AppName$ell" 100 }
    if ($elapsed -ge $TestSeconds) {
      if (-not [TandemUpdating.Native]::IsWindowVisible($form.Handle)) {
        Stop-OnError 'the window is not visible on screen'
        return
      }
      if ($ScreenshotPath) {
        # What is really on screen there (not a drawing of the window).
        $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($form.Location, [System.Drawing.Point]::Empty, $form.Size)
        $bmp.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      }
      $form.Close()
    }
    return
  }
  if ($elapsed -gt $TimeoutSeconds) { $form.Close(); return }
  if (-not $NoRelaunch -and (Test-NewAppRunning)) {
    Finish-Window "Done. Opening $AppName$ell" 1600
    return
  }
  # Installed and not opening by itself (closed with an update waiting), or
  # not opened 45 s after installing: say so, then go.
  if ($script:installedAt) {
    if ($NoRelaunch) { Finish-Window "$AppName is updated. Open it when you're ready." 4000; return }
    if (((Get-Date) - $script:installedAt).TotalSeconds -gt 45) { Finish-Window "$AppName is updated. Open it from the Start menu." 8000; return }
  }
  if ($InstallDir -and $Baseline -gt 0) {
    if ($script:measureHandle -and $script:measureHandle.IsCompleted) {
      try { $script:size = [double]($script:measure.EndInvoke($script:measureHandle) | Select-Object -Last 1) } catch {}
      $script:measure.Dispose()
      $script:measureHandle = $null
    }
    if (-not $script:measureHandle) { Start-Measure }
    $ratio = [Math]::Max(0, [Math]::Min(1, $script:size / $Baseline))
    if ($ratio -lt 0.6) { $script:removedSeen = $true }
    # Back to full size and no longer changing for 3 s: installed.
    if ($script:size -ne $script:lastSize) { $script:lastSize = $script:size; $script:stableSince = Get-Date }
    elseif ($script:removedSeen -and $ratio -ge 0.97 -and -not $script:installedAt -and ((Get-Date) - $script:stableSince).TotalSeconds -ge 3) {
      $script:installedAt = Get-Date
      Write-Log "installed (folder $([int64]$script:size) bytes)"
    }
    if (-not $script:removedSeen) {
      if ($elapsed -lt 4) { Set-Phase "Closing $AppName$ell" 5 } else { Set-Phase "Removing the old version$ell" 10 }
    } elseif ($ratio -lt 0.97) {
      Set-Phase "Installing the new version$ell" (12 + 80 * $ratio)
    } else {
      Set-Phase $(if ($NoRelaunch) { "Finishing$ell" } else { "Starting $AppName$ell" }) 95
    }
  } else {
    # Size unknown: phases by time, the bar creeping on.
    if ($elapsed -lt 4) { Set-Phase "Closing $AppName$ell" 5 }
    else { Set-Phase "Installing the new version$ell" ([Math]::Min(90, 5 + $elapsed * 2.5)) }
  }
} catch { Stop-OnError $_ } })

# Every 30 ms: the bar eases towards its target and the sheen slides across it.
$anim = New-Object System.Windows.Forms.Timer
$anim.Interval = 30
$anim.Add_Tick({ try {
  $script:shown += ($script:target - $script:shown) * 0.08
  $width = [int]($track.Width * $script:shown / 100)
  $fill.Width = [Math]::Max(6, $width)
  if ($script:finished -and $script:shown -gt 99) { $fill.BackColor = $done; $sheen.Visible = $false }
  $script:sheenX += 5
  if ($script:sheenX -gt $fill.Width + 60) { $script:sheenX = -44 }
  $sheen.Left = $script:sheenX
  $pct.Text = '{0}%' -f [int][Math]::Floor($script:shown)
} catch { Stop-OnError $_ } })

$form.Add_Shown({
  try {
    [void][TandemUpdating.Native]::ShowWindow($form.Handle, 5)  # SW_SHOW
    [void][TandemUpdating.Native]::SetForegroundWindow($form.Handle)
    $form.Activate()
  } catch { Write-Log "show: $_" }
  $visible = [TandemUpdating.Native]::IsWindowVisible($form.Handle)
  Write-Log "shown: visible=$visible"
  $check.Start()
  $anim.Start()
  # Tandem quits once this says the window is on screen.
  if ($ReadyFile -and $visible) { try { Set-Content -Path $ReadyFile -Value 'shown' -Encoding ASCII } catch {} }
})
$form.Add_FormClosed({ $check.Stop(); $anim.Stop(); Write-Log "closed: finished=$($script:finished) progress=$([int]$script:shown)" })
[void]$form.ShowDialog()
if ($script:failed) { exit 1 }
