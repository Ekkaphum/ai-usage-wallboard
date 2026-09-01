<#
.SYNOPSIS
  Turns this Windows machine into a display-only AI usage wallboard. One command.

.DESCRIPTION
  This machine shows accounts it is not logged in to and never will be. It reads
  nothing locally: a collector on the machine that *is* logged in pushes finished
  numbers to /api/ingest, and this box renders them. No credential of any kind
  is stored here.

  Run from the repository root. It re-launches itself elevated if it has to.

      .\deploy\windows\install.ps1

  Everything it needs that is missing — Node.js, the config files, the firewall
  rule, the startup tasks — it installs or writes. Anything it cannot decide it
  asks for.

.PARAMETER IngestToken
  Shared secret; must match INGEST_TOKEN on the collector machine exactly.
  Prompted for if omitted.

.PARAMETER CollectorIp
  IP of the machine that will push. The firewall rule is scoped to it so nothing
  else on the network can reach the board. Prompted for if omitted; blank means
  the whole local subnet.

.PARAMETER Port
  Port to serve on. Default 4000.

.PARAMETER NoKiosk
  Set up everything but do not open the fullscreen browser at the end.
#>
[CmdletBinding()]
param(
  [string]$IngestToken,
  [string]$CollectorIp,
  [int]$Port = 4000,
  [switch]$NoKiosk
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- elevation --

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "Needs administrator rights (scheduled task + firewall rule) — re-launching elevated..." -ForegroundColor Yellow
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$PSCommandPath`"")
  if ($IngestToken) { $argList += @("-IngestToken", "`"$IngestToken`"") }
  if ($CollectorIp) { $argList += @("-CollectorIp", "`"$CollectorIp`"") }
  $argList += @("-Port", $Port)
  if ($NoKiosk)     { $argList += "-NoKiosk" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  return
}

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

function Sync-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "AI usage wallboard — display-only setup" -ForegroundColor White
Write-Host "  $Root"

# ------------------------------------------------------------- what we need --

Step "Checking Node.js"
Sync-Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node.js is missing and winget is not available. Install Node 20+ from https://nodejs.org and re-run."
  }
  Warn "not found — installing via winget (this takes a few minutes)"
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
  Sync-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node was installed but is not on PATH yet. Close this window, open a new PowerShell, and re-run this script."
  }
}
$major = [int]((node --version) -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { throw "Node $(node --version) is too old; this needs Node 20 or newer." }
Ok "node $(node --version)"

# ------------------------------------------------------------ what we ask for --

if (-not $IngestToken) {
  Write-Host "`nThe collector machine and this one share a secret so that nothing else" -ForegroundColor White
  Write-Host "can push numbers onto your wall. On the Mac, read it with:" -ForegroundColor White
  Write-Host '    grep INGEST_TOKEN .env.local' -ForegroundColor Gray
  $secure = Read-Host "`nINGEST_TOKEN" -AsSecureString
  $IngestToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $IngestToken) { throw "INGEST_TOKEN cannot be empty — /api/ingest would refuse every push." }

if (-not $PSBoundParameters.ContainsKey("CollectorIp")) {
  Write-Host "`nIP of the machine that will push (blank = allow this whole local subnet)." -ForegroundColor White
  Write-Host "On the Mac:  ipconfig getifaddr en0" -ForegroundColor Gray
  $CollectorIp = (Read-Host "Collector IP").Trim()
}
$allowFrom = if ($CollectorIp) { $CollectorIp } else { "LocalSubnet" }

# ------------------------------------------------------------------- build --

Step "Installing dependencies"
# better-sqlite3 ships prebuilt binaries for Windows x64. On an architecture
# without one npm falls back to compiling, which needs the VS build tools.
if (Test-Path "package-lock.json") { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed. If it stopped on better-sqlite3, install build tools and retry:`n" +
        "    winget install Microsoft.VisualStudio.2022.BuildTools"
}
Ok "dependencies installed"

Step "Writing display-only configuration"
# An empty account list is the whole point. Without this file the app falls back
# to probing macOS default paths and renders three permanently broken cards.
$cfg = Join-Path $Root "config\accounts.json"
if (Test-Path $cfg) {
  Warn "config\accounts.json exists — left as is"
} else {
  '{ "accounts": [] }' | Set-Content -Path $cfg -Encoding UTF8
  Ok "config\accounts.json — no local accounts, everything arrives over the wire"
}

# Written without a BOM: Next reads this file itself and a BOM ends up inside
# the first variable's name.
$envText = @(
  "INGEST_TOKEN=$IngestToken",
  # Everything on screen came from somewhere else, so nothing here should be
  # editable from a browser on the network.
  "WALLBOARD_READONLY=1",
  "NODE_ENV=production"
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $Root ".env.local"), $envText, (New-Object Text.UTF8Encoding $false))
Ok ".env.local written — readonly mode on"

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null

Step "Building"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
Ok "built"

# ----------------------------------------------------------------- exposure --

Step "Opening port $Port to the collector"
$ruleName = "AI Wallboard ingest ($Port)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -RemoteAddress $allowFrom -Profile Private | Out-Null
Ok "inbound TCP $Port allowed from $allowFrom, private networks only"

# -------------------------------------------------------------- persistence --

Step "Registering startup tasks"
$serverScript = Join-Path $PSScriptRoot "start-server.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serverScript`" -Port $Port"
# A wall must survive a power blip unattended: restart on failure, and never
# stop just because the task has been running for weeks.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName "AI Wallboard Server" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "AI Wallboard Server" -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings `
  -Principal (New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest) | Out-Null
Ok "'AI Wallboard Server' — at startup, as SYSTEM"

$kioskScript = Join-Path $PSScriptRoot "kiosk.ps1"
Unregister-ScheduledTask -TaskName "AI Wallboard Kiosk" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "AI Wallboard Kiosk" `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$kioskScript`" -Port $Port") `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
Ok "'AI Wallboard Kiosk' — at logon"

Step "Keeping the screen awake"
powercfg /change monitor-timeout-ac 0   | Out-Null
powercfg /change standby-timeout-ac 0   | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok "display, sleep and hibernate timeouts disabled on AC power"

# ------------------------------------------------------------- verification --

Step "Starting the server"
Stop-ScheduledTask  -TaskName "AI Wallboard Server" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "AI Wallboard Server"

$deadline = (Get-Date).AddSeconds(60)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
      $up = $true; break
    }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) {
  throw "Server did not answer on port $Port within 60s. Check $Root\data\wallboard.err.log"
}
Ok "answering on http://127.0.0.1:$Port"

# The ingest path is the only thing that matters on this machine, and a token
# mismatch is the most common way for the whole setup to look silently dead —
# so prove the endpoint accepts this machine's own token before finishing.
Step "Testing the ingest endpoint"
try {
  Invoke-WebRequest "http://127.0.0.1:$Port/api/ingest" -Method POST -UseBasicParsing -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $IngestToken" } `
    -ContentType "application/json" -Body '{"bad":true}' | Out-Null
  Warn "endpoint accepted a malformed body — unexpected, but not fatal"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 400) { Ok "token accepted (rejected the test body as malformed, as it should)" }
  elseif ($code -eq 401) { throw "Ingest refused this token. The .env.local written here does not match what the server loaded — restart the task and retry." }
  else { Warn "unexpected response $code — check the server log" }
}

if (-not $NoKiosk) {
  Step "Opening the board"
  & (Join-Path $PSScriptRoot "kiosk.ps1") -Port $Port
}

$ips = @((Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress)

Write-Host "`n────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "Done. This machine is ready and waiting for data." -ForegroundColor Green
Write-Host "`nRun this on the machine that IS logged in to the accounts:" -ForegroundColor Cyan
foreach ($ip in $ips) {
  Write-Host "    ./deploy/collector/install-collector.sh http://$ip`:$Port" -ForegroundColor White
}
Write-Host "`nUntil then the board shows 'ยังไม่มีข้อมูล' — that is correct, not a fault." -ForegroundColor DarkGray
Write-Host "`n  update later :  .\deploy\windows\update.ps1"
Write-Host "  remove       :  .\deploy\windows\uninstall.ps1"
Write-Host "  server log   :  Get-Content data\wallboard.err.log -Tail 40"
