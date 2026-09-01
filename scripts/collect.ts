#!/usr/bin/env tsx
/**
 * Pushes this machine's usage to a wallboard running somewhere else.
 *
 * The quota figures a subscription plan enforces are not published by any API —
 * they exist only in files the desktop apps and CLIs write locally. So a screen
 * on another machine cannot pull them; the machine that is actually logged in
 * has to send them. This is that sender.
 *
 * What crosses the network is the finished numbers, never a credential: the
 * display machine never sees a token, and compromising it yields percentages.
 *
 *   WALLBOARD_URL=http://192.168.1.50:4000 INGEST_TOKEN=... npm run collect
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { probeAll } from '../lib/probe'
import { recordSnapshot } from '../lib/db/record'
import type { AccountState } from '../lib/domain/types'

/**
 * Reads .env.local so the shared secret lives in exactly one gitignored file
 * rather than being copied into a launchd plist, where it would sit in plain
 * text under a path that is easy to forget about.
 */
function loadEnvFile(): void {
  const path = resolve(process.cwd(), '.env.local')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line)
    if (!match) continue
    const [, key, raw] = match
    // Existing environment wins: an explicit override on the command line must
    // not be silently replaced by the file.
    if (process.env[key] != null) continue
    process.env[key] = raw.trim().replace(/^["']|["']$/g, '')
  }
}

loadEnvFile()

const args = process.argv.slice(2)
const once = args.includes('--once')
const quiet = args.includes('--quiet')
const intervalArg = args.find((a) => a.startsWith('--interval='))
const INTERVAL_MS = Math.max(15, Number(intervalArg?.split('=')[1] ?? 60)) * 1000

/** A push that hangs must not stall the next cycle. */
const REQUEST_TIMEOUT_MS = 10_000

const BASE = (process.env.WALLBOARD_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.INGEST_TOKEN ?? ''

function fail(message: string): never {
  console.error(`collect: ${message}`)
  process.exit(2)
}

if (!BASE) fail('set WALLBOARD_URL to the display machine, e.g. http://192.168.1.50:4000')
if (!TOKEN) fail('set INGEST_TOKEN to the same value the display machine uses')
if (!/^https?:\/\//.test(BASE)) fail(`WALLBOARD_URL must start with http:// or https:// (got "${BASE}")`)

const log = (line: string) => { if (!quiet) console.log(`${new Date().toLocaleTimeString('en-GB')} ${line}`) }

async function push(account: AccountState): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(account),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) return null

    const detail = await response.text().catch(() => '')
    // 401 is the one worth spelling out — it is almost always a token that was
    // copied to one machine and not the other.
    if (response.status === 401) return 'ปฏิเสธ (401) — INGEST_TOKEN สองเครื่องไม่ตรงกัน'
    return `HTTP ${response.status} ${detail.slice(0, 200)}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function cycle(): Promise<boolean> {
  const snapshot = await probeAll()

  // Recording locally too keeps this machine's own history intact, so the
  // collector can run on a machine that also shows its own board.
  try {
    recordSnapshot(snapshot)
  } catch (error) {
    console.error('collect: could not record locally:', error)
  }

  if (snapshot.accounts.length === 0) {
    log('ไม่มี account ที่อ่านได้ — ตรวจ config/accounts.json')
    return false
  }

  const results = await Promise.all(snapshot.accounts.map(async (account) => ({
    account,
    error: await push(account),
  })))

  const sent = results.filter((r) => !r.error)
  const failed = results.filter((r) => r.error)

  for (const { account, error } of failed) {
    console.error(`collect: ${account.displayName}: ${error}`)
  }

  if (sent.length) {
    const names = sent.map((r) => {
      const five = r.account.windows.find((w) => w.key === 'five_hour')?.usedPercent
      return `${r.account.displayName}${five == null ? '' : ` ${five.toFixed(0)}%`}`
    })
    log(`ส่งแล้ว ${sent.length}/${results.length} → ${BASE}  ·  ${names.join('  ·  ')}`)
  }

  return failed.length === 0
}

async function main() {
  const ok = await cycle()
  if (once) {
    process.exitCode = ok ? 0 : 1
    return
  }

  log(`ส่งทุก ${INTERVAL_MS / 1000} วินาที — Ctrl+C เพื่อหยุด`)
  // A failing cycle must not end the loop: the display machine being rebooted
  // is a normal event, and the collector should simply reconnect.
  setInterval(() => { void cycle().catch((error) => console.error('collect:', error)) }, INTERVAL_MS)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
