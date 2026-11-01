# CAPRI // native permission prompt
# Called by lib/hands-policy.js with a base64 JSON payload. Prints exactly one
# word to stdout: allow, trust or deny. Anything going wrong prints nothing,
# which the agent treats as deny.

param([Parameter(Mandatory = $true)][string]$Payload)

$ErrorActionPreference = "Stop"

$choice = "deny"
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $data = $json | ConvertFrom-Json
} catch {
  exit 0
}

if (-not [Environment]::UserInteractive) {
  Write-Output "deny"
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$pink = [System.Drawing.Color]::FromArgb(255, 79, 163)
$mint = [System.Drawing.Color]::FromArgb(125, 255, 212)
$dim = [System.Drawing.Color]::FromArgb(125, 136, 152)
$white = [System.Drawing.Color]::FromArgb(238, 238, 244)
$ink = [System.Drawing.Color]::FromArgb(10, 10, 14)
$panel = [System.Drawing.Color]::FromArgb(22, 22, 30)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Capri // Permission"
$form.Width = 560
$form.Height = 400
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.BackColor = $ink
$form.ForeColor = $white
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$kicker = New-Object System.Windows.Forms.Label
$kicker.Text = "CAPRI // PERMISSION REQUEST"
$kicker.ForeColor = $pink
$kicker.Font = New-Object System.Drawing.Font("Consolas", 10, [System.Drawing.FontStyle]::Bold)
$kicker.SetBounds(18, 14, 500, 20)
$form.Controls.Add($kicker)

$action = New-Object System.Windows.Forms.Label
$action.Text = [string]$data.action
$action.ForeColor = $white
$action.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$action.AutoEllipsis = $true
$action.SetBounds(18, 40, 508, 26)
$form.Controls.Add($action)

$preview = New-Object System.Windows.Forms.TextBox
$preview.Multiline = $true
$preview.ReadOnly = $true
$preview.ScrollBars = "Vertical"
$preview.WordWrap = $true
$preview.BackColor = $panel
$preview.ForeColor = $mint
$preview.BorderStyle = "FixedSingle"
$preview.Font = New-Object System.Drawing.Font("Consolas", 9)
$preview.Text = [string]$data.preview
$preview.SetBounds(18, 72, 508, 150)
$form.Controls.Add($preview)

$note = New-Object System.Windows.Forms.Label
$note.Text = [string]$data.note
$note.ForeColor = $dim
$note.SetBounds(18, 228, 508, 38)
$form.Controls.Add($note)

$countdown = New-Object System.Windows.Forms.Label
$countdown.ForeColor = $dim
$countdown.Font = New-Object System.Drawing.Font("Consolas", 8)
$countdown.SetBounds(18, 270, 508, 18)
$form.Controls.Add($countdown)

function New-CapriButton([string]$text, [int]$x, [int]$w, [bool]$filled) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.SetBounds($x, 306, $w, 34)
  $b.FlatStyle = "Flat"
  $b.FlatAppearance.BorderSize = 1
  if ($filled) {
    $b.BackColor = $pink
    $b.ForeColor = [System.Drawing.Color]::FromArgb(18, 0, 10)
    $b.FlatAppearance.BorderColor = $pink
  } else {
    $b.BackColor = $panel
    $b.ForeColor = $white
    $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(70, 70, 84)
  }
  $form.Controls.Add($b)
  return $b
}

$allow = New-CapriButton "ALLOW ONCE" 18 140 $true
$trust = $null
if ([bool]$data.allowTrust) {
  $trust = New-CapriButton "ALWAYS ALLOW" 168 150 $false
}
$deny = New-CapriButton "DENY" 418 108 $false

$allow.Add_Click({ $script:choice = "allow"; $form.Close() })
if ($trust) { $trust.Add_Click({ $script:choice = "trust"; $form.Close() }) }
$deny.Add_Click({ $script:choice = "deny"; $form.Close() })

# Nothing is selected for a stray Enter to confirm. Escape and the window X both
# deny, and so does waiting.
$form.CancelButton = $deny
$form.Add_FormClosing({ if ($script:choice -eq "") { $script:choice = "deny" } })
$form.Add_Shown({
  $form.Activate()
  $deny.Focus() | Out-Null
})

$script:left = [int]$data.seconds
if ($script:left -le 0) { $script:left = 30 }
$countdown.Text = "AUTO-DENY IN $($script:left)s - nothing runs until you choose"

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:left -= 1
  if ($script:left -le 0) {
    $timer.Stop()
    $script:choice = "deny"
    $form.Close()
    return
  }
  $countdown.Text = "AUTO-DENY IN $($script:left)s - nothing runs until you choose"
})
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()

if ($script:choice -eq "allow" -or $script:choice -eq "trust") {
  Write-Output $script:choice
} else {
  Write-Output "deny"
}
