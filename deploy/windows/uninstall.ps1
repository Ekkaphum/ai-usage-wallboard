<#
.SYNOPSIS
  Removes the wallboard's footprint from Windows. Leaves the repo and its data.

.DESCRIPTION
  Unregisters both scheduled tasks, closes the firewall port, and shuts the
  kiosk browser. The checkout, the database and .env.local stay — delete the
  folder yourself if you want them gone.
#>
[CmdletBinding()]
param([int]$Port = 4000, [switch]$RestorePowerDefaults)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $a = @("-NoProfile","-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`"","-Port",$Port)
  if ($RestorePowerDefaults) { $a += "-RestorePowerDefaults" }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $a
  return
}

function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
Write-Host "==> Removing" -ForegroundColor Cyan

foreach ($task in "AI Wallboard Server", "AI Wallboard Kiosk") {
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Ok "task '$task' removed"
  }
}

$rule = Get-NetFirewallRule -DisplayName "AI Wallboard ingest ($Port)" -ErrorAction SilentlyContinue
if ($rule) { $rule | Remove-NetFirewallRule; Ok "firewall rule removed" }

foreach ($name in "chrome", "msedge") {
  Get-CimInstance Win32_Process -Filter "Name='$name.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*ai-wallboard-browser*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Ok "kiosk $name closed" }
}

if ($RestorePowerDefaults) {
  # Windows' own shipping defaults, since the originals were not recorded.
  powercfg /change monitor-timeout-ac 10 | Out-Null
  powercfg /change standby-timeout-ac 30 | Out-Null
  Ok "power timeouts set back to Windows defaults (10 / 30 min)"
} else {
  Write-Host "    display sleep is still disabled — re-run with -RestorePowerDefaults to undo" -ForegroundColor Yellow
}

Write-Host "`nDone. The checkout and data\ are untouched." -ForegroundColor Green
