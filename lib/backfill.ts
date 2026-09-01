import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type AppConfig } from '@/lib/config'
import { getDb, schema } from '@/lib/db/client'
import { expandHome, DEFAULT_CLAUDE_APP_DATA } from '@/lib/domain/paths'
import { PLAN_USAGE_FILE, type PlanUsageSample } from '@/lib/adapters/claude-desktop-plan-usage'
import { annotateBlocks, deriveReset } from '@/lib/calc/blocks'
import { makeWindow, emptyBurn } from '@/lib/domain/types'

/**
 * Imports the history the Claude desktop app already holds.
 *
 * The app retains roughly a month of samples, so the dashboard can draw a real
 * 30-day chart the first time it runs instead of starting empty and waiting.
 * Samples are keyed by their own timestamp, so running this repeatedly — or
 * alongside the live poller — cannot duplicate a point.
 */

export interface BackfillResult {
  configId: string
  org: string | null
  read: number
  inserted: number
  from: string | null
  to: string | null
  error?: string
}

export function backfillAll(config?: AppConfig): BackfillResult[] {
  const cfg = config ?? loadConfig()
  const results: BackfillResult[] = []

  for (const account of cfg.accounts) {
    if (!account.enabled || account.adapter !== 'claude-desktop-plan-usage') continue
    const dir = expandHome(account.appDataDir ?? DEFAULT_CLAUDE_APP_DATA)
    const file = join(dir, PLAN_USAGE_FILE)

    if (!existsSync(file)) {
      results.push({ configId: account.id, org: null, read: 0, inserted: 0, from: null, to: null, error: `No ${file}` })
      continue
    }

    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; samples: PlanUsageSample[] }
      if (raw.version !== 2) throw new Error(`unrecognised schema version ${raw.version}`)

      const byOrg = new Map<string, PlanUsageSample[]>()
      for (const s of raw.samples) {
        if (account.org && s.org !== account.org) continue
        const list = byOrg.get(s.org)
        if (list) list.push(s)
        else byOrg.set(s.org, [s])
      }

      for (const [org, samples] of byOrg) {
        samples.sort((a, b) => a.t - b.t)
        results.push({ ...importOrg(account.id, org, samples), configId: account.id, org })
      }
    } catch (error) {
      results.push({
        configId: account.id, org: null, read: 0, inserted: 0, from: null, to: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

function importOrg(configId: string, org: string, samples: PlanUsageSample[]): Omit<BackfillResult, 'configId' | 'org'> {
  const db = getDb()
  const blocks = annotateBlocks(samples.map((s) => ({ t: s.t, percent: s.u.fh })))
  const observedAt = Date.now()
  let inserted = 0

  db.transaction((tx) => {
    tx.insert(schema.accounts).values({
      id: org,
      configId,
      provider: 'anthropic',
      surface: 'claude-desktop',
      displayName: configId,
      planType: null,
      firstSeenAt: samples[0].t,
      lastSeenAt: observedAt,
    }).onConflictDoUpdate({
      target: schema.accounts.id,
      set: { firstSeenAt: samples[0].t, lastSeenAt: observedAt },
    }).run()

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]
      const block = blocks[i]

      const five = makeWindow({
        key: 'five_hour', label: '5-hour session', windowMinutes: 300,
        usedPercent: s.u.fh, confidence: 'reported',
      })
      if (block) {
        const reset = deriveReset(block, s.t)
        five.resetsAt = new Date(reset.at).toISOString()
        five.resetConfidence = 'derived'
        five.resetUncertaintyMs = reset.uncertaintyMs
      }

      const windows = [five, makeWindow({
        key: 'weekly', label: 'Weekly', windowMinutes: 10080,
        usedPercent: s.u.sd, confidence: 'reported',
      })]
      if (s.u.xu != null) {
        windows.push(makeWindow({
          key: 'credit', label: 'Extra usage', windowMinutes: 0,
          usedPercent: Math.max(0, Math.min(100, 100 - s.u.xu)), confidence: 'derived',
        }))
      }

      const res = tx.insert(schema.samples).values({
        accountId: org,
        takenAt: s.t,
        observedAt,
        fivePercent: s.u.fh,
        weekPercent: s.u.sd,
        windowsJson: JSON.stringify(windows),
        burnJson: JSON.stringify(emptyBurn()),
        health: 'ok',
        message: null,
      }).onConflictDoNothing().run()
      inserted += res.changes

      if (s.u.fh >= 100) {
        tx.insert(schema.limitHits).values({
          accountId: org, ts: s.t, windowKey: 'five_hour',
          resetsAt: five.resetsAt ? Date.parse(five.resetsAt) : null,
          source: 'plan-usage-100',
        }).onConflictDoNothing().run()
      }
    }
  })

  return {
    read: samples.length,
    inserted,
    from: new Date(samples[0].t).toISOString(),
    to: new Date(samples[samples.length - 1].t).toISOString(),
  }
}
