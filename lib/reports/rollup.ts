import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

/**
 * Ages out detail the board no longer needs.
 *
 * Per-message rows are what make the recent view precise, but months of them
 * only slow queries down. Beyond the retention window they are collapsed into
 * one row per account, model, and hour — same totals, a fraction of the rows.
 */

const RETAIN_EVENTS_DAYS = 90
const RETAIN_SAMPLES_DAYS = 365

export interface RollupResult {
  collapsedFrom: number
  collapsedTo: number
  samplesDeleted: number
  cutoff: string
}

export function rollupOldEvents(now = Date.now()): RollupResult {
  const db = getDb()
  const cutoff = now - RETAIN_EVENTS_DAYS * 24 * 3_600_000
  const sampleCutoff = now - RETAIN_SAMPLES_DAYS * 24 * 3_600_000

  /*
   * Rows already collapsed keep a timestamp older than the cutoff forever, so
   * without excluding them every run would rewrite the whole history and vacuum
   * for nothing. The synthetic request id is what marks them.
   */
  const before = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM usage_events
    WHERE ts < ${cutoff} AND request_id NOT LIKE 'rollup:%'
  `)?.n ?? 0
  if (before === 0) {
    return { collapsedFrom: 0, collapsedTo: 0, samplesDeleted: 0, cutoff: new Date(cutoff).toISOString() }
  }

  let after = 0
  let samplesDeleted = 0

  db.transaction((tx) => {
    // Aggregate into a temp table first, so a failure mid-way leaves the
    // original rows untouched rather than half-collapsed.
    tx.run(sql`
      CREATE TEMP TABLE rollup AS
      SELECT account_id, (ts / 3600000) * 3600000 AS hour, model,
             SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
             SUM(thinking_tokens) AS thinking_tokens, SUM(cost_usd) AS cost_usd,
             COUNT(*) AS n
      FROM usage_events WHERE ts < ${cutoff} AND request_id NOT LIKE 'rollup:%'
      GROUP BY account_id, hour, model
    `)

    tx.run(sql`DELETE FROM usage_events WHERE ts < ${cutoff} AND request_id NOT LIKE 'rollup:%'`)

    tx.run(sql`
      INSERT INTO usage_events
        (account_id, ts, model, session_id, project, request_id, message_id, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost_usd)
      SELECT account_id, hour, model, NULL, NULL,
             'rollup:' || account_id || ':' || hour, COALESCE(model, 'unknown'), 0,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost_usd
      FROM rollup
      -- SQLite cannot tell an upsert clause from part of the SELECT without a
      -- WHERE here; see "Parsing Ambiguity" in its UPSERT documentation.
      WHERE true
      -- Late-arriving history for an hour already collapsed adds into the
      -- existing row rather than being rejected by the unique key.
      ON CONFLICT(request_id, message_id) DO UPDATE SET
        input_tokens       = usage_events.input_tokens       + excluded.input_tokens,
        output_tokens      = usage_events.output_tokens      + excluded.output_tokens,
        cache_read_tokens  = usage_events.cache_read_tokens  + excluded.cache_read_tokens,
        cache_write_tokens = usage_events.cache_write_tokens + excluded.cache_write_tokens,
        thinking_tokens    = usage_events.thinking_tokens    + excluded.thinking_tokens,
        cost_usd           = COALESCE(usage_events.cost_usd, 0) + COALESCE(excluded.cost_usd, 0)
    `)

    after = tx.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM rollup`)?.n ?? 0
    tx.run(sql`DROP TABLE rollup`)

    const deleted = tx.run(sql`DELETE FROM samples WHERE taken_at < ${sampleCutoff}`)
    samplesDeleted = deleted.changes
  })

  db.run(sql`VACUUM`)

  return { collapsedFrom: before, collapsedTo: after, samplesDeleted, cutoff: new Date(cutoff).toISOString() }
}
