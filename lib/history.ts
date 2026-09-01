import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

/** One point on a card's sparkline. */
export interface HistoryPoint {
  t: number
  five: number | null
  week: number | null
}

export type History = Record<string, HistoryPoint[]>

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const MAX_POINTS = 90

/**
 * Recent percentage history per account, for the sparklines.
 *
 * Points are thinned to a fixed budget so a card that has been polled every few
 * seconds for hours does not ship thousands of samples the sparkline cannot
 * resolve anyway. The newest point is always kept — it is the one the eye goes to.
 */
export function recentHistory(windowMs = DEFAULT_WINDOW_MS, now = Date.now()): History {
  const db = getDb()
  const rows = db.all<{ account_id: string; taken_at: number; five: number | null; week: number | null }>(sql`
    SELECT account_id, taken_at, five_percent AS five, week_percent AS week
    FROM samples
    WHERE taken_at >= ${now - windowMs}
    ORDER BY account_id, taken_at
  `)

  const grouped: History = {}
  for (const row of rows) {
    ;(grouped[row.account_id] ??= []).push({ t: row.taken_at, five: row.five, week: row.week })
  }

  for (const [id, points] of Object.entries(grouped)) {
    grouped[id] = thin(points, MAX_POINTS)
  }
  return grouped
}

function thin(points: HistoryPoint[], max: number): HistoryPoint[] {
  if (points.length <= max) return points
  const step = points.length / max
  const out: HistoryPoint[] = []
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)])
  out.push(points[points.length - 1])
  return out
}
