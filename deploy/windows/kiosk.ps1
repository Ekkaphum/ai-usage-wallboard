<#
  Opens the board fullscreen on this machine's display.

  Uses a dedicated browser profile so kiosk mode never inherits a restore-tabs
  prompt, a signed-in profile, or an extension bar onto the wall.
#>
[CmdletBinding()]
param(
  [int]$Port = 4000,
  [string]$Url
)

$ErrorActionPreference = "Stop"
if (-not $Url) { $Url = "http://127.0.0.1:$Port/?kiosk=1" }

try {
  Invoke-WebRequest "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  throw "Server is not answering on port $Port. Start it with:  Start-ScheduledTask -TaskName 'AI Wallboard Server'"
}

$profileDir = Join-Path $env:LOCALAPPDATA "ai-wallboard-browser"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

# Edge ships with Windows, so it is the reliable default; Chrome wins if present
# because it is what the macOS side is tested against.
$candidates = @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw "Neither Chrome nor Edge was found." }

# Kill only our own kiosk, never the user's ordinary browser: the isolated
# profile path is what tells the two apart.
Get-CimInstance Win32_Process -Filter "Name='$(Split-Path $browser -Leaf)'" |
  Where-Object { $_.CommandLine -like "*ai-wallboard-browser*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process $browser -ArgumentList @(
  "--user-data-dir=$profileDir",
  "--kiosk", $Url,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--disable-features=TranslateUI,InfiniteSessionRestore",
  "--autoplay-policy=no-user-gesture-required"
)

Write-Host "kiosk open at $Url  (using $(Split-Path $browser -Leaf))" -ForegroundColor Green
Write-Host "close it with:  Get-Process chrome,msedge -EA 0 | Where CommandLine -like '*ai-wallboard-browser*' | Stop-Process"
