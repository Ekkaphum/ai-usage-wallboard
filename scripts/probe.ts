#!/usr/bin/env tsx
import { probeAll } from '../lib/probe'
import { recordSnapshot } from '../lib/db/record'
import { loadConfig } from '../lib/config'
import type { AccountState, LimitWindow } from '../lib/domain/types'

const asJson = process.argv.includes('--json')
const save = process.argv.includes('--save')

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', grey: '\x1b[90m',
} as const

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code: string, s: string) => (useColor ? `${code}${s}${C.reset}` : s)

function severity(pct: number | null): string {
  if (pct == null) return C.grey
  if (pct >= 95) return C.red
  if (pct >= 80) return C.red
  if (pct >= 60) return C.yellow
  return C.green
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return c(C.grey, 'ไม่ทราบ')
  const ms = Date.parse(iso) - now
  if (ms <= 0) return c(C.grey, 'ครบแล้ว')
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function bar(pct: number | null, width = 24): string {
  if (pct == null) return c(C.grey, '·'.repeat(width))
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return c(severity(pct), '█'.repeat(filled)) + c(C.grey, '░'.repeat(width - filled))
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

function renderWindow(w: LimitWindow, now: number): string[] {
  const lines: string[] = []
  if (w.usedPercent == null && w.usedTokens != null) {
    // No budget to divide by — show the real counter rather than a blank gauge.
    lines.push(
      `  ${w.label.padEnd(15)} ${c(C.cyan, `${tokens(w.usedTokens)} tok`.padStart(9))}  ` +
      `${c(C.grey, 'ยังไม่มี % — แสดงค่าดิบ'.padEnd(24))}  ${c(C.dim, w.confidence.padEnd(9))}`,
    )
  } else {
    const pct = w.usedPercent == null ? '  — ' : `${w.usedPercent.toFixed(0).padStart(3)}%`
    lines.push(
      `  ${w.label.padEnd(15)} ${c(severity(w.usedPercent), pct)}  ${bar(w.usedPercent)}  ` +
      `${c(C.dim, w.confidence.padEnd(9))}`,
    )
  }
  if (w.windowMinutes > 0) {
    const uncertainty = w.resetUncertaintyMs
      ? c(C.grey, ` ±${Math.round(w.resetUncertaintyMs / 60000)}m`)
      : ''
    lines.push(
      `  ${''.padEnd(15)} ${c(C.dim, 'reset in')} ${countdown(w.resetsAt, now)}${uncertainty}` +
      `  ${c(C.dim, `(${w.resetConfidence})`)}`,
    )
  }
  if (w.note) lines.push(`  ${''.padEnd(15)} ${c(C.grey, w.note)}`)
  return lines
}

function renderAccount(a: AccountState, now: number): string {
  const badge =
    a.health === 'ok' ? c(C.green, '●') :
    a.health === 'stale' ? c(C.yellow, '◐') :
    a.health === 'error' ? c(C.red, '✕') : c(C.grey, '○')

  const head = `${badge} ${c(C.bold, a.displayName)} ${c(C.dim, `${a.provider}/${a.surface}${a.planType ? ` · ${a.planType}` : ''}`)}`
  const lines = [head]

  if (a.accountId !== a.configId) lines.push(`  ${c(C.grey, `org ${a.accountId}`)}`)

  for (const w of a.windows) lines.push(...renderWindow(w, now))

  if (a.burn.percentPerHour != null) {
    lines.push(`  ${'burn'.padEnd(15)} ${c(C.cyan, `${a.burn.percentPerHour.toFixed(1)} %/ชม.`)}`)
  }
  if (a.burn.projectedExhaustAt) {
    const t = new Date(a.burn.projectedExhaustAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    lines.push(`  ${''.padEnd(15)} ${c(C.yellow, `▲ คาดว่าเต็มเวลา ${t} — ก่อนรีเซ็ต`)}`)
  }
  if (a.spend.todayUsd != null || a.spend.weekUsd != null) {
    const today = a.spend.todayUsd != null ? `$${a.spend.todayUsd.toFixed(2)}` : '—'
    const week = a.spend.weekUsd != null ? `$${a.spend.weekUsd.toFixed(2)}` : '—'
    lines.push(`  ${'spend'.padEnd(15)} ${c(C.cyan, `วันนี้ ${today}`)}  ${c(C.dim, `สัปดาห์ ${week}`)}`)
  }
  if (a.breakdown?.length) {
    const top = a.breakdown.slice(0, 4).map((b) => {
      const tok = b.tokens >= 1e6 ? `${(b.tokens / 1e6).toFixed(1)}M` : `${Math.round(b.tokens / 1e3)}k`
      return `${b.model.replace('claude-', '')} ${tok}`
    })
    lines.push(`  ${'models (7d)'.padEnd(15)} ${c(C.dim, top.join('  ·  '))}`)
  }
  if (a.lastSampleAt) {
    const age = Math.round((now - Date.parse(a.lastSampleAt)) / 60000)
    lines.push(`  ${'last sample'.padEnd(15)} ${c(C.dim, age <= 0 ? 'เมื่อครู่' : `${age} นาทีที่แล้ว`)}`)
  }
  if (a.message) lines.push(`  ${c(a.health === 'error' ? C.red : C.grey, a.message)}`)

  return lines.join('\n')
}

async function main() {
  const snapshot = await probeAll(process.env.PROBE_CONFIG ? loadConfig(process.env.PROBE_CONFIG) : undefined)
  const saved = save ? recordSnapshot(snapshot) : null

  if (asJson) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n')
    return
  }

  const now = Date.parse(snapshot.generatedAt)
  console.log()
  console.log(c(C.bold, 'AI USAGE') + c(C.dim, `  ${new Date(now).toLocaleString('en-GB')}`))
  console.log()

  for (const problem of snapshot.problems) {
    console.log(c(C.red, `!  ${problem}`))
  }
  if (snapshot.problems.length) console.log()

  for (const account of snapshot.accounts) {
    console.log(renderAccount(account, now))
    console.log()
  }

  if (saved) console.log(c(C.dim, `saved ${saved.inserted} new sample(s) to the database`) + '\n')

  const unhealthy = snapshot.accounts.filter((a) => a.health === 'error').length
  process.exitCode = unhealthy > 0 || snapshot.problems.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
