import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'

/**
 * Rollup deletes rows, so it is covered end to end against a real database
 * rather than by inspecting the SQL. The property that matters is that the
 * totals a bill is reconciled against survive the collapse untouched.
 */

const DB_PATH = 'data/test-rollup.db'
const DAY = 24 * 3_600_000

let db: Awaited<typeof import('@/lib/db/client')>['getDb'] extends () => infer T ? T : never
let schema: typeof import('@/lib/db/schema')
let rollupOldEvents: typeof import('@/lib/reports/rollup').rollupOldEvents

const now = Date.now()
const OLD_TS = now - 120 * DAY
const RECENT_TS = now - 3 * DAY
const ROWS = 400

beforeAll(async () => {
  process.env.DATABASE_PATH = DB_PATH
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true })

  const client = await import('@/lib/db/client')
  schema = await import('@/lib/db/schema')
  rollupOldEvents = (await import('@/lib/reports/rollup')).rollupOldEvents
  db = client.getDb()

  const rows = Array.from({ length: ROWS }, (_, i) => ({
    accountId: 'rollup-test',
    // Half fall outside the retention window, half inside it.
    ts: (i % 2 === 0 ? OLD_TS : RECENT_TS) + (i % 37) * 3_600_000,
    model: i % 2 === 0 ? 'claude-opus-5' : 'claude-sonnet-5',
    sessionId: `session-${i % 7}`,
    project: 'demo',
    requestId: `req-${i}`,
    messageId: `msg-${i}`,
    isSidechain: false,
    inputTokens: 100 + i,
    outputTokens: 50 + i,
    cacheReadTokens: 900 + i,
    cacheWriteTokens: 10 + i,
    thinkingTokens: 5,
    costUsd: (i + 1) * 0.001,
  }))
  db.insert(schema.usageEvents).values(rows).run()
})

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true })
})

function totals() {
  return db.get<{ n: number; tokens: number; cost: number }>(sql`
    SELECT COUNT(*) AS n,
           SUM(input_tokens + output_tokens + cache_write_tokens) AS tokens,
           SUM(cost_usd) AS cost
    FROM usage_events WHERE account_id = 'rollup-test'
  `)!
}

describe('rollupOldEvents', () => {
  it('collapses old rows without changing the totals', () => {
    const before = totals()
    expect(before.n).toBe(ROWS)

    const result = rollupOldEvents(now)
    expect(result.collapsedFrom).toBe(ROWS / 2)
    expect(result.collapsedTo).toBeLessThan(result.collapsedFrom)

    const after = totals()
    expect(after.tokens).toBe(before.tokens)
    expect(after.cost).toBeCloseTo(before.cost, 6)
    expect(after.n).toBeLessThan(before.n)
  })

  it('leaves rows inside the retention window fully intact', () => {
    const detailed = db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM usage_events
      WHERE account_id = 'rollup-test' AND session_id IS NOT NULL
    `)!
    expect(detailed.n).toBe(ROWS / 2)
  })

  it('is a no-op when run again', () => {
    const before = totals()
    const result = rollupOldEvents(now)
    expect(result.collapsedFrom).toBe(0)
    expect(totals()).toEqual(before)
  })
})
