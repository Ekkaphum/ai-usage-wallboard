import type { Confidence, Health, LimitWindow } from '@/lib/domain/types'

export type Severity = 'ok' | 'warn' | 'high' | 'crit' | 'unknown'

export function severityOf(percent: number | null): Severity {
  if (percent == null) return 'unknown'
  if (percent >= 95) return 'crit'
  if (percent >= 80) return 'high'
  if (percent >= 60) return 'warn'
  return 'ok'
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  high: 'var(--warn)',
  crit: 'var(--crit)',
  unknown: 'var(--dim)',
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

export function formatUsd(n: number | null): string {
  if (n == null) return '—'
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}

/** `4:12:07`, counting down. Returns null once the target has passed. */
export function formatCountdown(targetMs: number, nowMs: number): string | null {
  const ms = targetMs - nowMs
  if (ms <= 0) return null
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatAge(iso: string | null, nowMs: number): string {
  if (!iso) return 'ไม่มีข้อมูล'
  const ms = nowMs - Date.parse(iso)
  if (ms < 60_000) return 'เมื่อครู่'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ชม.ที่แล้ว`
  return `${Math.round(hours / 24)} วันที่แล้ว`
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  reported: 'reported',
  derived: 'derived',
  estimated: 'estimated',
  unknown: 'calibrating',
}

export function confidenceLabel(c: Confidence): string {
  return CONFIDENCE_LABEL[c]
}

/** The badge earns its place by being honest, so it never renders as decoration. */
export function confidenceColor(c: Confidence): string {
  switch (c) {
    case 'reported': return 'var(--ok)'
    case 'derived': return 'var(--accent)'
    case 'estimated': return 'var(--warn)'
    default: return 'var(--dim)'
  }
}

export const HEALTH_MARK: Record<Health, string> = {
  ok: '●',
  stale: '◐',
  error: '✕',
  unconfigured: '○',
}

export function primaryWindow(windows: LimitWindow[]): LimitWindow | null {
  return windows.find((w) => w.key === 'five_hour')
    ?? windows.find((w) => w.key === 'daily')
    ?? windows[0]
    ?? null
}

export function windowByKey(windows: LimitWindow[], key: LimitWindow['key']): LimitWindow | null {
  return windows.find((w) => w.key === key) ?? null
}
