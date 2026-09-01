# Windows: display-only wallboard

This machine shows AI accounts it is not logged in to. It reads nothing locally
and stores no credentials — a collector elsewhere pushes finished numbers to
`/api/ingest` and this box renders them.

## Install

From an ordinary PowerShell, in the repository root. It elevates itself:

```powershell
.\deploy\windows\install.ps1
```

It asks for two things and handles everything else:

| asks for | where to get it (on the collector machine) |
|---|---|
| `INGEST_TOKEN` | `grep INGEST_TOKEN .env.local` |
| collector IP | `ipconfig getifaddr en0` |

Then: installs Node if missing, `npm ci`, writes `config/accounts.json` as an
empty account list and `.env.local` in readonly mode, builds, opens the firewall
port scoped to the collector only, registers a SYSTEM task at startup and a
kiosk task at logon, disables display sleep, verifies the server answers and
that the token is accepted, and opens the board fullscreen.

It finishes by printing the exact command to run back on the collector machine.

## Scripts

| | |
|---|---|
| `install.ps1` | the one command above |
| `update.ps1` | `git pull` + rebuild + restart, leaving config and token alone |
| `uninstall.ps1` | removes both tasks, the firewall rule, and the kiosk |
| `start-server.ps1` | what the startup task runs; usable by hand for debugging |
| `kiosk.ps1` | opens the fullscreen browser on its own isolated profile |

## Checking on it

```powershell
Get-ScheduledTask "AI Wallboard *" | Select TaskName, State
(Invoke-WebRequest http://127.0.0.1:4000/api/state).Content | ConvertFrom-Json | % externalCount
Get-Content data\wallboard.err.log -Tail 40
```

`externalCount` is how many accounts arrived from the collector. `0` with an
empty board means nothing has been pushed yet.

## When something is wrong

| symptom | cause |
|---|---|
| board says `ยังไม่มีข้อมูล` | no push has landed yet — normal before the collector is installed |
| a card says it has been stale for N minutes | pushes stopped; check the collector, not this machine |
| collector logs `401` | the two `INGEST_TOKEN` values differ |
| collector logs a timeout | firewall scope is wrong — re-run `install.ps1` with the right collector IP |
| `npm ci` stops on better-sqlite3 | no prebuilt binary for this architecture: `winget install Microsoft.VisualStudio.2022.BuildTools` |

Background and the collector side: [../../docs/REMOTE.md](../../docs/REMOTE.md)
