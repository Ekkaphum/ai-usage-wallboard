<#
.SYNOPSIS
  Sets this Windows machine up as a display-only AI usage wallboard.

.DESCRIPTION
  This machine shows accounts it is not logged in to. It reads nothing locally;
  a collector on the machine that *is* logged in pushes finished numbers to
  /api/ingest, and this box renders them.

  Run from an elevated PowerShell in the repository root:
      .\deploy\windows\setup.ps1 -IngestToken "<same token as the collector>"

.PARAMETER IngestToken
  Shared secret. Must match INGEST_TOKEN on the collector machine exactly.
  Without it the ingest endpoint stays closed and no data can arrive.

.PARAMETER Port
  Port to serve on. Default 4000.

.PARAMETER AllowFrom
  IP address of the collector machine. The firewall rule is scoped to it, so
  nothing else on the network can reach the board. Omit to allow the whole
  local subnet.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$IngestToken,
  [int]$Port = 4000,
  [string]$AllowFrom = "LocalSubnet"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated PowerShell (Run as Administrator) — it registers a scheduled task and a firewall rule."
}

Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js not found. Install it first:  winget install OpenJS.NodeJS.LTS   then open a new PowerShell."
}
$major = [int]((node --version) -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { throw "Node $((node --version)) is too old; this needs Node 20 or newer." }
Ok "node $(node --version)"

Step "Installing dependencies"
# better-sqlite3 ships prebuilt binaries for Windows x64; if this machine is on
# an architecture without one, npm falls back to compiling and will need
# `winget install Microsoft.VisualStudio.2022.BuildTools`.
if (Test-Path "package-lock.json") { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Step "Writing display-only configuration"
# An empty account list is the point: with no entry here the app would fall back
# to probing macOS default paths and render three permanently broken cards.
$cfg = Join-Path $Root "config\accounts.json"
if (Test-Path $cfg) {
  Warn "config\accounts.json already exists — left as is"
} else {
  '{ "accounts": [] }' | Set-Content -Path $cfg -Encoding UTF8
  Ok "config\accounts.json (display-only, no local accounts)"
}

$envFile = Join-Path $Root ".env.local"
@(
  "INGEST_TOKEN=$IngestToken",
  # Everything on screen came from somewhere else, so nothing here should be
  # editable from a browser on the network.
  "WALLBOARD_READONLY=1",
  "NODE_ENV=production"
) -join "`r`n" | Set-Content -Path $envFile -Encoding UTF8
Ok ".env.local written (readonly mode on)"

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null

Step "Building"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Step "Opening port $Port for the collector"
$ruleName = "AI Wallboard ingest ($Port)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -RemoteAddress $AllowFrom -Profile Private | Out-Null
Ok "inbound TCP $Port allowed from $AllowFrom (private networks only)"

Step "Registering the server as a startup task"
$serverScript = Join-Path $PSScriptRoot "start-server.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serverScript`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtStartup
# The board must survive a power blip unattended, so it restarts on failure and
# does not stop just because the task has been running for days.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Unregister-ScheduledTask -TaskName "AI Wallboard Server" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "AI Wallboard Server" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName "AI Wallboard Server"
Ok "task 'AI Wallboard Server' registered and started"

Step "Registering the kiosk to open at logon"
$kioskScript = Join-Path $PSScriptRoot "kiosk.ps1"
$kAction = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$kioskScript`" -Port $Port"
$kTrigger = New-ScheduledTaskTrigger -AtLogOn
Unregister-ScheduledTask -TaskName "AI Wallboard Kiosk" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "AI Wallboard Kiosk" -Action $kAction -Trigger $kTrigger `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
Ok "task 'AI Wallboard Kiosk' registered"

Step "Keeping the screen awake"
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Ok "display and sleep timeouts disabled on AC power"

Step "Verifying"
$deadline = (Get-Date).AddSeconds(45)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
      $up = $true; break
    }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) { throw "Server did not answer on port $Port within 45s. Check data\wallboard.err.log." }
Ok "server answering on port $Port"

$ips = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress

Write-Host "`nDone." -ForegroundColor Green
Write-Host "`nPoint the collector on the Mac at one of these:" -ForegroundColor Cyan
foreach ($ip in $ips) { Write-Host "    WALLBOARD_URL=http://$ip`:$Port" }
Write-Host "`nStart the kiosk now with:  .\deploy\windows\kiosk.ps1" -ForegroundColor Cyan
