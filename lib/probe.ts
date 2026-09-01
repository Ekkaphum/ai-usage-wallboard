import { loadConfig, validateConfig, type AppConfig } from '@/lib/config'
import { getAdapter } from '@/lib/adapters'
import type { AccountState } from '@/lib/domain/types'
import { unconfigured } from '@/lib/domain/types'

export interface Snapshot {
  generatedAt: string
  accounts: AccountState[]
  problems: string[]
}

/**
 * Runs every enabled adapter. One adapter failing must never take the board
 * down, so failures are turned into an error card for that account only.
 */
export async function probeAll(config?: AppConfig): Promise<Snapshot> {
  const cfg = config ?? loadConfig()
  const problems = validateConfig(cfg)
  const enabled = cfg.accounts.filter((a) => a.enabled)

  const results = await Promise.all(enabled.map(async (account) => {
    const adapter = getAdapter(account.adapter)
    if (!adapter) {
      return [unconfigured(
        account.id, account.displayName, 'custom', 'api',
        `Unknown adapter "${account.adapter}".`,
      )]
    }
    try {
      return await adapter.probe(account)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const state = unconfigured(account.id, account.displayName, 'custom', 'api', message)
      state.health = 'error'
      return [state]
    }
  }))

  const attachments = new Map<string, AccountState[]>()
  for (const account of enabled) {
    if (!account.attachTo) continue
    const produced = results[enabled.indexOf(account)]
    attachments.set(account.attachTo, produced)
  }

  const standalone = enabled
    .filter((a) => !a.attachTo)
    .flatMap((a) => results[enabled.indexOf(a)])

  return {
    generatedAt: new Date().toISOString(),
    accounts: standalone.map((a) => merge(a, attachments)),
    problems,
  }
}

/**
 * Claude Code usage is drawn from the same subscription the desktop app reports
 * on, so its cost and model split belong on that account's card rather than a
 * second one that would read as a separate quota.
 */
function merge(account: AccountState, attachments: Map<string, AccountState[]>): AccountState {
  const attached = attachments.get(account.configId)
  if (!attached?.length) return account

  const usable = attached.filter((a) => a.health === 'ok' || a.health === 'stale')
  if (usable.length === 0) return account

  const sum = (pick: (a: AccountState) => number | null) => {
    const values = usable.map(pick).filter((v): v is number => v != null)
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }

  const breakdown = new Map<string, { tokens: number; costUsd: number | null }>()
  for (const source of usable) {
    for (const entry of source.breakdown ?? []) {
      const existing = breakdown.get(entry.model)
      breakdown.set(entry.model, {
        tokens: (existing?.tokens ?? 0) + entry.tokens,
        costUsd: entry.costUsd == null && existing?.costUsd == null
          ? null
          : (existing?.costUsd ?? 0) + (entry.costUsd ?? 0),
      })
    }
  }

  return {
    ...account,
    spend: {
      todayUsd: sum((a) => a.spend.todayUsd),
      weekUsd: sum((a) => a.spend.weekUsd),
    },
    breakdown: [...breakdown.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
  }
}
