import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { loadConfig } from '@/lib/config'
import { WEEK_MS } from '@/lib/domain/types'

/** Everything the detail page needs, in one place so the page stays declarative. */

export interface HourlyPoint { hour: number; tokens: number; costUsd: number | null }
export interface ModelRow { model: string; tokens: number; costUsd: number | null; events: number }
export interface SessionRow { sessionId: string; project: string | null; startedAt: number; endedAt: number; tokens: number; costUsd: number | null }
export interface LimitHitRow { ts: number; windowKey: string; resetsAt: number | null; source: string }
export interface PercentPointRow { t: number; five: number | null; week: number | null }

export interface AccountReport {
  accountId: string
  usageId: string
  displayName: string
  provider: string
  surface: string
  planType: string | null
  hourly: HourlyPoint[]
  models: ModelRow[]
  sessions: SessionRow[]
  limitHits: LimitHitRow[]
  percentHistory: PercentPointRow[]
  totals: { tokens: number; costUsd: number | null; events: number }
}

const DAYS = 7

export function listAccounts(): { id: string; displayName: string }[] {
  const db = getDb()
  return db.all<{ id: string; displayName: string }>(sql`
    SELECT id, display_name AS displayName FROM accounts ORDER BY display_name
  `)
}

/**
 * Claude's percentages are stored under the org UUID, while its token rows are
 * written by the Claude Code adapter under a different id that `attachTo` folds
 * into the same card. That attached account is merged away before anything is
 * recorded, so it has no row in `accounts` — the pairing only exists in the
 * config, which is where this has to look.
 */
export function resolveUsageId(accountId: string): string {
  const db = getDb()
  const own = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ${accountId}`)
  if ((own?.n ?? 0) > 0) return accountId

  const configId = db.get<{ config_id: string }>(sql`
    SELECT config_id FROM accounts WHERE id = ${accountId}
  `)?.config_id
  if (!configId) return accountId

  const attached = loadConfig().accounts.filter((a) => a.attachTo === configId)
  for (const candidate of attached) {
    const rows = db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ${candidate.id}
    `)
    if ((rows?.n ?? 0) > 0) return candidate.id
  }
  return accountId
}

export function buildReport(accountId: string, usageIdOverride?: string, now = Date.now()): AccountReport | null {
  const db = getDb()
  const since = now - DAYS * 24 * 3_600_000

  const account = db.get<{ id: string; display_name: string; provider: string; surface: string; plan_type: string | null }>(sql`
    SELECT id, display_name, provider, surface, plan_type FROM accounts WHERE id = ${accountId}
  `)
  if (!account) return null

  const usageId = usageIdOverride ?? resolveUsageId(accountId)

  const hourly = db.all<{ hour: number; tokens: number; cost: number | null }>(sql`
    SELECT (ts / 3600000) * 3600000 AS hour,
           SUM(input_tokens + output_tokens + cache_write_tokens) AS tokens,
           SUM(cost_usd) AS cost
    FROM usage_events WHERE account_id = ${usageId} AND ts >= ${since}
    GROUP BY hour ORDER BY hour
  `).map((r) => ({ hour: r.hour, tokens: r.tokens, costUsd: r.cost }))

  const models = db.all<{ model: string; tokens: number; cost: number | null; events: number }>(sql`
    SELECT COALESCE(model, 'unknown') AS model,
           SUM(input_tokens + output_tokens + cache_write_tokens) AS tokens,
           SUM(cost_usd) AS cost, COUNT(*) AS events
    FROM usage_events WHERE account_id = ${usageId} AND ts >= ${since}
    GROUP BY model ORDER BY tokens DESC
  `).map((r) => ({ model: r.model, tokens: r.tokens, costUsd: r.cost, events: r.events }))

  const sessions = db.all<{ sessionId: string; project: string | null; startedAt: number; endedAt: number; tokens: number; cost: number | null }>(sql`
    SELECT session_id AS sessionId, project,
           MIN(ts) AS startedAt, MAX(ts) AS endedAt,
           SUM(input_tokens + output_tokens + cache_write_tokens) AS tokens,
           SUM(cost_usd) AS cost
    FROM usage_events
    WHERE account_id = ${usageId} AND ts >= ${since} AND session_id IS NOT NULL
    GROUP BY session_id ORDER BY endedAt DESC LIMIT 25
  `).map((r) => ({ sessionId: r.sessionId, project: r.project, startedAt: r.startedAt, endedAt: r.endedAt, tokens: r.tokens, costUsd: r.cost }))

  const limitHits = db.all<LimitHitRow>(sql`
    SELECT ts, window_key AS windowKey, resets_at AS resetsAt, source
    FROM limit_hits WHERE account_id IN (${accountId}, ${usageId})
    ORDER BY ts DESC LIMIT 40
  `)

  const percentHistory = db.all<PercentPointRow>(sql`
    SELECT taken_at AS t, five_percent AS five, week_percent AS week
    FROM samples WHERE account_id = ${accountId} AND taken_at >= ${now - WEEK_MS}
    ORDER BY taken_at
  `)

  const totals = {
    tokens: hourly.reduce((n, h) => n + h.tokens, 0),
    costUsd: hourly.some((h) => h.costUsd != null)
      ? hourly.reduce((n, h) => n + (h.costUsd ?? 0), 0)
      : null,
    events: models.reduce((n, m) => n + m.events, 0),
  }

  return {
    accountId,
    usageId,
    displayName: account.display_name,
    provider: account.provider,
    surface: account.surface,
    planType: account.plan_type,
    hourly,
    models,
    sessions,
    limitHits,
    percentHistory,
    totals,
  }
}

/** CSV of the hourly series — the shape people actually paste into a spreadsheet. */
export function toCsv(report: AccountReport): string {
  const rows = ['hour_iso,tokens,cost_usd']
  for (const point of report.hourly) {
    rows.push(`${new Date(point.hour).toISOString()},${point.tokens},${point.costUsd?.toFixed(6) ?? ''}`)
  }
  return `${rows.join('\n')}\n`
}
