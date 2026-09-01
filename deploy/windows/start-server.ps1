<#
  Runs the wallboard server. Invoked by the "AI Wallboard Server" scheduled task
  at boot; safe to run by hand for debugging.

  Bound to 0.0.0.0 rather than loopback because the collector on another machine
  has to reach /api/ingest. The firewall rule written by install.ps1 is what keeps
  that from meaning "anyone on the network".
#>
[CmdletBinding()]
param([int]$Port = 4000)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $Root

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
$env:NODE_ENV = "production"

$next = Join-Path $Root "node_modules\next\dist\bin\next"
if (-not (Test-Path $next)) { throw "next not found — run npm ci in $Root first." }

& node $next start --hostname 0.0.0.0 --port $Port `
  1>> (Join-Path $Root "data\wallboard.log") `
  2>> (Join-Path $Root "data\wallboard.err.log")
