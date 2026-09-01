import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { allTokenBlocks, type TokenPoint } from './blocks'

/**
 * Turning a token count into a percentage requires a budget, and Anthropic
 * publishes none for subscription plans. This recovers one empirically, in
 * descending order of trust, and returns null rather than inventing a number
 * when there is not enough evidence — a card that admits it does not know beats
 * a card that quietly guesses.
 *
 * This is a fallback path. When the desktop app's plan-usage file is readable
 * its reported percentages are used instead and none of this runs.
 */

export type BudgetSource = 'configured' | 'observed-limit-hit' | 'p95-of-history'

export interface Budget {
  tokens: number
  source: BudgetSource
  /** How many observations back this figure. */
  observations: number
}

/** A block must carry at least this many events before it can define a ceiling. */
const MIN_EVENTS_PER_BLOCK = 5
/** Below this many completed blocks, the P95 estimate is not worth showing. */
const MIN_BLOCKS_FOR_P95 = 8

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

function pointsFor(accountId: string, since: number): TokenPoint[] {
  const db = getDb()
  return db.all<{ t: number; tokens: number }>(sql`
    SELECT ts AS t, input_tokens + output_tokens + cache_write_tokens AS tokens
    FROM usage_events WHERE account_id = ${accountId} AND ts >= ${since}
  `)
}

function hitTimestamps(accountId: string, since: number): number[] {
  const db = getDb()
  return db.all<{ ts: number }>(sql`
    SELECT ts FROM limit_hits
    WHERE account_id = ${accountId} AND window_key = 'five_hour' AND ts >= ${since}
    ORDER BY ts
  `).map((r) => r.ts)
}

export function budgetForFiveHour(accountId: string, configured: number | null, now = Date.now()): Budget | null {
  if (configured && configured > 0) {
    return { tokens: configured, source: 'configured', observations: 0 }
  }

  const since = now - LOOKBACK_MS
  const blocks = allTokenBlocks(pointsFor(accountId, since))
    .filter((b) => b.events >= MIN_EVENTS_PER_BLOCK)
  if (blocks.length === 0) return null

  // Best evidence: a block that ended in an actual 429 was, by definition, full.
  const hits = hitTimestamps(accountId, since)
  const exhausted = blocks.filter((b) => hits.some((ts) => ts >= b.startedAt && ts < b.resetsAt))
  if (exhausted.length > 0) {
    const tokens = Math.max(...exhausted.map((b) => b.tokens))
    return { tokens, source: 'observed-limit-hit', observations: exhausted.length }
  }

  // Weaker evidence: assume the heaviest sessions approached the ceiling.
  if (blocks.length < MIN_BLOCKS_FOR_P95) return null
  const sorted = blocks.map((b) => b.tokens).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  return { tokens: Math.round(p95 * 1.1), source: 'p95-of-history', observations: blocks.length }
}
