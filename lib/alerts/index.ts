import { getDb, schema } from '@/lib/db/client'
import type { AccountState, LimitWindow } from '@/lib/domain/types'
import type { BoardPayload } from '@/lib/runtime/store'
import { loadAlertConfig } from './config'
import { deliver } from './notify'

/**
 * Threshold alerting.
 *
 * The hard part is not deciding when to fire but making sure a threshold fires
 * *once* per window rather than on every poll — at a 60-second cadence a naive
 * check would send sixty messages an hour for one problem. Each firing is
 * recorded against an identifier for the specific window instance, so the next
 * five-hour block can legitimately alert again while the current one cannot.
 */

export interface Alert {
  accountId: string
  displayName: string
  windowKey: string
  windowLabel: string
  threshold: number
  usedPercent: number
  resetsAt: string | null
  confidence: string
}

/**
 * Identifies one instance of a window. Reset time is the natural key: it is
 * unique per block and already on the wire. Windows without one fall back to
 * the day, which is the right granularity for a balance that only trends.
 */
function windowInstance(window: LimitWindow, now: number): string {
  if (window.resetsAt) {
    // Rounded to the minute so a derived reset drifting by seconds between
    // polls does not read as a brand-new window.
    return String(Math.round(Date.parse(window.resetsAt) / 60_000))
  }
  return new Date(now).toISOString().slice(0, 10)
}

function candidates(account: AccountState, thresholds: number[], now: number): { alert: Alert; instance: string }[] {
  const out: { alert: Alert; instance: string }[] = []
  if (account.health === 'error' || account.health === 'unconfigured') return out

  for (const window of account.windows) {
    const percent = window.usedPercent
    if (percent == null) continue
    // A percentage we invented should not wake anyone up.
    if (window.confidence === 'unknown') continue

    const crossed = thresholds.filter((t) => percent >= t).sort((a, b) => b - a)[0]
    if (crossed == null) continue

    out.push({
      instance: windowInstance(window, now),
      alert: {
        accountId: account.accountId,
        displayName: account.displayName,
        windowKey: window.key,
        windowLabel: window.label,
        threshold: crossed,
        usedPercent: percent,
        resetsAt: window.resetsAt,
        confidence: window.confidence,
      },
    })
  }
  return out
}

/** Records a firing, returning false when this threshold already fired for this window. */
function claim(alert: Alert, instance: string, now: number): boolean {
  const db = getDb()
  const result = db.insert(schema.alerts).values({
    accountId: alert.accountId,
    windowKey: alert.windowKey,
    threshold: alert.threshold,
    windowInstance: instance,
    firedAt: now,
  }).onConflictDoNothing().run()
  return result.changes > 0
}

export async function evaluate(payload: BoardPayload, now = Date.now()): Promise<Alert[]> {
  const config = loadAlertConfig()
  const active = config.channels.filter((c) => c.enabled)
  if (active.length === 0 || config.thresholds.length === 0) return []

  const fired: Alert[] = []
  for (const account of payload.accounts) {
    for (const { alert, instance } of candidates(account, config.thresholds, now)) {
      if (!claim(alert, instance, now)) continue
      fired.push(alert)
    }
  }

  if (fired.length > 0) {
    await deliver(fired, active)
  }
  return fired
}
