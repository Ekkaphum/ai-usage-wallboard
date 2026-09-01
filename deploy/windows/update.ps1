<#
.SYNOPSIS
  Pulls the latest code from GitHub and redeploys, without touching config.

.DESCRIPTION
  config\accounts.json and .env.local are gitignored, so an update never
  disturbs the token or the display-only setting. Run from anywhere in the repo.

      .\deploy\windows\update.ps1
#>
[CmdletBinding()]
param([int]$Port = 4000, [switch]$NoKiosk)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Re-launching elevated (restarting the SYSTEM task needs it)..." -ForegroundColor Yellow
  $a = @("-NoProfile","-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`"","-Port",$Port)
  if ($NoKiosk) { $a += "-NoKiosk" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $a
  return
}

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

Step "Fetching"
$before = (git rev-parse --short HEAD)
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
  throw "git pull failed. If it reports local changes, this machine should not have any — inspect with 'git status'."
}
$after = (git rev-parse --short HEAD)
if ($before -eq $after) { Ok "already at $after — nothing to do"; return }
Ok "$before -> $after"

Step "Installing dependencies"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

Step "Building"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed — the old server is still running, nothing was broken." }

Step "Restarting"
Stop-ScheduledTask  -TaskName "AI Wallboard Server" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "AI Wallboard Server"

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
      Ok "server back up on port $Port"
      if (-not $NoKiosk) { & (Join-Path $PSScriptRoot "kiosk.ps1") -Port $Port }
      Write-Host "`nUpdated to $after." -ForegroundColor Green
      return
    }
  } catch { Start-Sleep -Seconds 2 }
}
throw "Server did not come back within 60s. Check data\wallboard.err.log"
