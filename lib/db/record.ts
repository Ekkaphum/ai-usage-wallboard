import { sql } from 'drizzle-orm'
import { getDb, schema } from './client'
import type { AccountState } from '@/lib/domain/types'
import type { Snapshot } from '@/lib/probe'

/**
 * Persists a snapshot. Samples are keyed by the *source* timestamp so re-polling
 * between the app's 15-minute writes, or backfilling history, cannot create
 * duplicate points.
 */
export function recordSnapshot(snapshot: Snapshot): { inserted: number } {
  const db = getDb()
  const observedAt = Date.parse(snapshot.generatedAt)
  let inserted = 0

  db.transaction((tx) => {
    for (const account of snapshot.accounts) {
      // Accounts we could not read have no point on the time series; recording
      // one per poll would fill the table with rows that mean nothing.
      tx.insert(schema.accounts).values({
        id: account.accountId,
        configId: account.configId,
        provider: account.provider,
        surface: account.surface,
        displayName: account.displayName,
        planType: account.planType,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      }).onConflictDoUpdate({
        target: schema.accounts.id,
        set: {
          displayName: account.displayName,
          planType: account.planType,
          configId: account.configId,
          lastSeenAt: observedAt,
        },
      }).run()

      // Accounts we could not read have no point on the time series; recording
      // one per poll would fill the table with rows that mean nothing.
      if (!account.lastSampleAt) continue
      const takenAt = Date.parse(account.lastSampleAt)

      const result = tx.insert(schema.samples).values({
        accountId: account.accountId,
        takenAt,
        observedAt,
        fivePercent: pct(account, 'five_hour'),
        weekPercent: pct(account, 'weekly'),
        windowsJson: JSON.stringify(account.windows),
        burnJson: JSON.stringify(account.burn),
        health: account.health,
        message: account.message,
      }).onConflictDoNothing().run()
      inserted += result.changes

      for (const window of account.windows) {
        if (!window.hitAt) continue
        tx.insert(schema.limitHits).values({
          accountId: account.accountId,
          ts: Date.parse(window.hitAt),
          windowKey: window.key,
          resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null,
          source: 'observed-100',
        }).onConflictDoNothing().run()
      }
    }
  })

  return { inserted }
}

function pct(account: AccountState, key: string): number | null {
  return account.windows.find((w) => w.key === key)?.usedPercent ?? null
}

/** Newest sample per account, for serving the board without re-probing. */
export function latestSamples() {
  const db = getDb()
  return db.all<{ account_id: string; taken_at: number; windows_json: string; burn_json: string; health: string; message: string | null }>(sql`
    SELECT s.account_id, s.taken_at, s.windows_json, s.burn_json, s.health, s.message
    FROM samples s
    JOIN (SELECT account_id, MAX(taken_at) AS mx FROM samples GROUP BY account_id) m
      ON m.account_id = s.account_id AND m.mx = s.taken_at
  `)
}
