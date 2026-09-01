#!/usr/bin/env tsx
import { backfillAll } from '../lib/backfill'

const results = backfillAll()
for (const r of results) {
  if (r.error) {
    console.error(`✕ ${r.configId}: ${r.error}`)
    continue
  }
  const span = r.from && r.to
    ? `${r.from.slice(0, 10)} → ${r.to.slice(0, 10)}`
    : '—'
  console.log(`● ${r.configId} (${r.org?.slice(0, 8)}): read ${r.read}, inserted ${r.inserted}  ${span}`)
}
process.exitCode = results.some((r) => r.error) ? 1 : 0
