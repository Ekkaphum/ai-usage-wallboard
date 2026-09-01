<#
.SYNOPSIS
  One-line bootstrap: fetches the repository and runs the installer.

.DESCRIPTION
  Meant to be piped straight from GitHub onto a machine with nothing on it:

      irm https://raw.githubusercontent.com/Ekkaphum/ai-usage-wallboard/main/deploy/windows/bootstrap.ps1 | iex

  Installs git if it is missing, clones (or updates) the checkout, and hands off
  to install.ps1, which elevates itself and asks for the two things it needs.

  Because this runs before the repository exists, it cannot take parameters the
  normal way — set them as environment variables first if you want to skip the
  prompts:

      $env:WALLBOARD_DIR  = "D:\wallboard"     # default C:\ai-wallboard
      $env:WALLBOARD_PORT = "4000"
#>

$ErrorActionPreference = "Stop"

$repo = "https://github.com/Ekkaphum/ai-usage-wallboard.git"
$dir  = if ($env:WALLBOARD_DIR)  { $env:WALLBOARD_DIR }  else { "C:\ai-wallboard" }
$port = if ($env:WALLBOARD_PORT) { [int]$env:WALLBOARD_PORT } else { 4000 }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

function Sync-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "AI usage wallboard — bootstrap" -ForegroundColor White

Step "Checking git"
Sync-Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "git is missing and winget is unavailable. Install git from https://git-scm.com and re-run."
  }
  Write-Host "    not found — installing via winget" -ForegroundColor Yellow
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent
  Sync-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git was installed but is not on PATH yet. Open a new PowerShell and run this again."
  }
}
Ok (git --version)

Step "Fetching the repository"
if (Test-Path (Join-Path $dir ".git")) {
  Ok "already at $dir — updating"
  git -C $dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "git pull failed in $dir. Inspect it with: git -C $dir status" }
} else {
  if ((Test-Path $dir) -and (Get-ChildItem $dir -Force | Select-Object -First 1)) {
    throw "$dir exists and is not empty, but is not a checkout of this repository. Move it aside or set `$env:WALLBOARD_DIR."
  }
  git clone --quiet $repo $dir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
  Ok "cloned to $dir"
}

Step "Handing off to the installer"
Set-Location $dir
& (Join-Path $dir "deploy\windows\install.ps1") -Port $port
